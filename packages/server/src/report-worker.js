import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { decodeReport, parseReport, shiftBounds } from "@lizi/core";
import { getSetting, setSetting, transaction } from "./database.js";
import { httpError, isWithin } from "./directories.js";
import { initializeOutbox, enqueueReport, readSyncConfig, validateBackfillRange } from "./sync-outbox.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const BATCH_FILES = 32;
const BATCH_BYTES = 1024 * 1024;
const PAGE_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_DAYS = 4;
const MAX_PENDING_PATHS = 256;
// Parser changes invalidate fingerprints only when their date is requested.
const fingerprint = (stat) =>
  `2:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const db = new DatabaseSync(workerData.database);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;",
);
initializeOutbox(db);
let root = getSetting(db, "dataPath");
let revision = Number(getSetting(db, "revision", "0"));
let generation = Number(getSetting(db, "scanGeneration", "0"));
let closed = false;
let rootVersion = 0;
let rootWatcher;
let pumping = false;
let timer;
let acquisitionRunning = false;
let baselineRunning = false;
const active = new Map();
const snapshots = new Map();
const privateHome = path.dirname(workerData.database);
const scanErrors = new Map();
let status = {
  root,
  revision,
  reportCount: 0,
  watching: false,
  scanning: false,
  lastScan: null,
  errors: [],
  activeDates: [],
  scanProgress: {
    phase: "idle",
    visited: 0,
    indexed: 0,
    invalid: 0,
    changed: 0,
    parsed: 0,
    startedAt: null,
  },
};

// Migration runs only in this bounded worker. Existing accounts/settings/reports survive.
const columns = new Set(
  db
    .prepare("PRAGMA table_info(reports)")
    .all()
    .map((column) => column.name),
);
transaction(db, () => {
  if (!columns.has("root")) {
    db.exec("ALTER TABLE reports ADD COLUMN root TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE reports SET root=?").run(root);
  }
  if (!columns.has("detail_count"))
    db.exec("ALTER TABLE reports ADD COLUMN detail_count INTEGER");
  db.exec(`
    CREATE INDEX IF NOT EXISTS reports_root_time ON reports(root,timestamp);
    CREATE TABLE IF NOT EXISTS report_files (
      path TEXT PRIMARY KEY, root TEXT NOT NULL, scope TEXT NOT NULL,
      fingerprint TEXT NOT NULL, valid INTEGER NOT NULL, generation INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS report_files_scope ON report_files(root,scope,generation,path);
    CREATE TABLE IF NOT EXISTS report_counts (root TEXT PRIMARY KEY, count INTEGER NOT NULL);
  `);
  if (getSetting(db, "reportIndexVersion") !== "1") {
    db.exec(`INSERT OR IGNORE INTO report_files(path,root,scope,fingerprint,valid,generation)
      SELECT path,root,substr(path,length(root)+2,10),fingerprint,1,0 FROM reports;
      INSERT OR REPLACE INTO report_counts SELECT root,COUNT(*) FROM reports GROUP BY root;`);
    setSetting(db, "reportIndexVersion", "1");
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS report_count_insert AFTER INSERT ON reports BEGIN
      INSERT INTO report_counts(root,count) VALUES(NEW.root,1)
      ON CONFLICT(root) DO UPDATE SET count=count+1;
    END;
    CREATE TRIGGER IF NOT EXISTS report_count_delete AFTER DELETE ON reports BEGIN
      UPDATE report_counts SET count=count-1 WHERE root=OLD.root;
    END;
  `);
});
db.exec("CREATE INDEX IF NOT EXISTS report_files_invalid ON report_files(root,valid,scope)");

const fileRow = db.prepare(
  "SELECT fingerprint,valid,error FROM report_files WHERE path=? AND root=?",
);
const markSeen = db.prepare(
  "UPDATE report_files SET generation=? WHERE path=? AND root=?",
);
const writeFile =
  db.prepare(`INSERT INTO report_files(path,root,scope,fingerprint,valid,generation,error) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET root=excluded.root,scope=excluded.scope,fingerprint=excluded.fingerprint,
  valid=excluded.valid,generation=excluded.generation,error=excluded.error`);
const writeReport =
  db.prepare(`INSERT INTO reports(path,id,fingerprint,timestamp,line,aggregate,json,root,detail_count) VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(path) DO UPDATE SET id=excluded.id,fingerprint=excluded.fingerprint,timestamp=excluded.timestamp,
  line=excluded.line,aggregate=excluded.aggregate,json=excluded.json,root=excluded.root,detail_count=excluded.detail_count`);
const deleteReport = db.prepare("DELETE FROM reports WHERE path=? AND root=?");
const deleteFile = db.prepare(
  "DELETE FROM report_files WHERE path=? AND root=?",
);

function removeReport(file, reportRoot) {
  const previous = db.prepare("SELECT id,json FROM reports WHERE path=? AND root=?").get(file, reportRoot);
  if (previous) enqueueReport(db, previous.id, previous.json, true);
  return deleteReport.run(file, reportRoot);
}

function publish() {
  status.root = root;
  status.revision = revision;
  status.reportCount =
    db.prepare("SELECT count FROM report_counts WHERE root=?").get(root)
      ?.count ?? 0;
  status.activeDates = [...active.keys()];
  const errors = new Map(scanErrors);
  const invalid = db.prepare("SELECT path,error FROM report_files WHERE root=? AND valid=0 LIMIT 100").all(root);
  for (const row of invalid) if (!errors.has(row.path)) errors.set(row.path, row.error);
  status.errors = [...errors].slice(0, 100).map(([file, message]) => ({ path: file, message }));
  status.watching =
    Boolean(rootWatcher) || [...active.values()].some((scope) => scope.watcher);
  parentPort.postMessage({ type: "status", status });
}

function recordError(file, error) {
  scanErrors.set(file, error.message);
  while (scanErrors.size > 100) scanErrors.delete(scanErrors.keys().next().value);
}

function changed(count) {
  if (!count) return;
  revision += 1;
  setSetting(db, "revision", revision);
  status.scanProgress.changed += count;
}

function excluded(file) {
  if (
    isWithin(root, privateHome) &&
    root !== privateHome &&
    isWithin(privateHome, file)
  )
    return true;
  if (
    file === workerData.database ||
    file.startsWith(`${workerData.database}-`)
  )
    return true;
  return (
    root === privateHome &&
    !/^\d{4}-\d{2}-\d{2}$/.test(path.relative(root, file).split(path.sep)[0])
  );
}

async function authorized(file, directory = false) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink())
    throw new Error("报告路径包含符号链接，已拒绝读取");
  const actual = await fs.realpath(file);
  if (
    actual !== file ||
    !isWithin(root, actual) ||
    excluded(actual) ||
    !workerData.allowedRoots.some((allowed) => isWithin(allowed, actual))
  ) {
    throw new Error("报告路径超出授权目录或指向服务私有数据");
  }
  if (directory && !stat.isDirectory()) throw new Error("报告日期路径不是目录");
  return stat;
}

function current(scope, version) {
  return !closed && version === rootVersion && active.get(scope.date) === scope;
}

function queue(scope, file) {
  if (closed || active.get(scope.date) !== scope) return;
  if (file && path.relative(scope.directory, file).split(path.sep).length > 2)
    return;
  clearTimeout(scope.retryTimer);
  scope.retryTimer = null;
  if (file && !scope.full) {
    scope.paths.add(file);
    if (scope.paths.size > MAX_PENDING_PATHS) {
      scope.paths.clear();
      scope.full = true;
    }
  } else if (!file) {
    scope.full = true;
    scope.paths.clear();
  }
  if (!scope.completion) {
    scope.completion = new Promise((resolve) => {
      scope.resolve = resolve;
    });
  }
  if (!timer)
    timer = setTimeout(() => {
      timer = null;
      pump().catch(fatal);
    }, 250);
}

async function attachScopeWatcher(scope) {
  if (scope.watcher || closed) return;
  try {
    const version = rootVersion;
    await authorized(scope.directory, true);
    if (!current(scope, version)) return;
    scope.watcher = watch(
      scope.directory,
      { recursive: true },
      (_event, name) => {
        if (!name) return queue(scope);
        const file = path.resolve(scope.directory, String(name));
        if (isWithin(scope.directory, file) && !excluded(file))
          queue(scope, file);
      },
    );
    scope.watcher.on("error", (error) => {
      scope.watcher?.close();
      scope.watcher = null;
      recordError(
        scope.directory,
        new Error(`实时监控异常，低频日期核对仍启用：${error.message}`),
      );
      publish();
    });
  } catch (error) {
    if (error.code !== "ENOENT") recordError(scope.directory, error);
  }
}

async function attachRootWatcher() {
  rootWatcher?.close();
  rootWatcher = null;
  if (!root || closed) return;
  try {
    const version = rootVersion;
    await authorized(root, true);
    if (closed || version !== rootVersion) return;
    // Non-recursive: never ask the OS to index years of inactive date directories.
    rootWatcher = watch(root, (_event, name) => {
      const scope = active.get(String(name ?? "").split(path.sep)[0]);
      if (scope) {
        scope.watcher?.close();
        scope.watcher = null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(scope.date)) markDiscovered(scope.date);
        queue(scope);
      }
      else {
        const date = String(name ?? "").split(path.sep)[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) markDiscovered(date);
      }
    });
    rootWatcher.on("error", (error) => {
      rootWatcher?.close();
      rootWatcher = null;
      recordError(root, error);
      publish();
    });
  } catch (error) {
    recordError(root, error);
  }
}

function datesFor(query) {
  shiftBounds(query.date, query.shift);
  const dates = [query.date];
  if (query.shift !== "day") {
    const next = new Date(`${query.date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    dates.push(next.toISOString().slice(0, 10));
  }
  return dates;
}

function activate(query) {
  const dates = datesFor(query);
  if (!root) return [];
  return dates.map((date) => {
    let scope = active.get(date);
    if (!scope) {
      while (active.size >= MAX_ACTIVE_DAYS) {
        const today = localDay();
        const yesterday = nextDay(today, -1);
        const [oldDate, old] = [...active.entries()].find(([day]) => day !== today && day !== yesterday);
        old.watcher?.close();
        clearTimeout(old.retryTimer);
        old.resolve?.();
        active.delete(oldDate);
      }
      scope = {
        date,
        directory: path.join(root, date),
        paths: new Set(),
        full: false,
        watcher: null,
      };
      active.set(date, scope);
      queue(scope);
    } else {
      active.delete(date);
      active.set(date, scope);
    }
    return scope;
  });
}

async function scanScope(scope, target) {
  const version = rootVersion;
  const scanRoot = root;
  const scanGeneration = ++generation;
  for (const file of scanErrors.keys()) {
    if (file === target || file.startsWith(`${target}${path.sep}`)) scanErrors.delete(file);
  }
  setSetting(db, "scanGeneration", generation);
  let batch = [];
  let bytes = 0;
  let safeToPrune = true;
  let deferred = false;
  let visitedSinceFlush = 0;
  const progress = status.scanProgress;
  function flush() {
    if (!current(scope, version)) {
      batch = [];
      bytes = 0;
      return;
    }
    transaction(db, () => {
      let modifications = 0;
      for (const item of batch) {
        if (item.unchanged) {
          markSeen.run(scanGeneration, item.file, scanRoot);
          continue;
        }
        writeFile.run(
          item.file,
          scanRoot,
          scope.date,
          item.signature,
          Number(Boolean(item.json)),
          scanGeneration,
          item.error ?? null,
        );
        if (item.json) {
          const previous = db
            .prepare("SELECT json,root FROM reports WHERE path=?")
            .get(item.file);
          if (previous?.json !== item.json || previous?.root !== scanRoot) {
            if (previous && previous.root !== scanRoot)
              removeReport(item.file, previous.root);
            writeReport.run(
              item.file,
              item.id,
              item.signature,
              item.timestamp,
              item.line,
              item.aggregate,
              item.json,
              scanRoot,
              item.detailCount,
            );
            enqueueReport(db, item.id, item.json, scope.historical ?? false);
            modifications += 1;
          }
        } else {
          modifications += removeReport(item.file, scanRoot).changes;
        }
      }
      changed(modifications);
    });
    batch = [];
    bytes = 0;
    visitedSinceFlush = 0;
    publish();
  }
  async function processFile(file, stat) {
    progress.visited += 1;
    visitedSinceFlush += 1;
    const signature = fingerprint(stat);
    const previous = fileRow.get(file, scanRoot);
    if (previous?.fingerprint === signature) {
      batch.push({ file, unchanged: true });
      if (previous.valid) progress.indexed += 1;
      else {
        progress.invalid += 1;
        if (previous.error) recordError(file, new Error(previous.error));
      }
      return;
    }
    if (Date.now() - stat.mtimeMs < 1500) {
      if (previous) batch.push({ file, unchanged: true });
      deferred = true;
      return;
    }
    try {
      if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过8 MiB上限");
      const handle = await fs.open(file, "r");
      let buffer;
      try {
        if (fingerprint(await handle.stat()) !== signature) {
          deferred = true;
          return;
        }
        buffer = Buffer.allocUnsafe(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (
          length !== stat.size ||
          fingerprint(await handle.stat()) !== signature
        ) {
          deferred = true;
          return;
        }
        buffer = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      if (fingerprint(await authorized(file)) !== signature) {
        deferred = true;
        return;
      }
      if (!current(scope, version)) return;
      progress.parsed += 1;
      const report = parseReport(decodeReport(buffer));
      report.id = createHash("sha256")
        .update(`${scanRoot}\0${path.relative(scanRoot, file)}`)
        .digest("hex")
        .slice(0, 32);
      const json = JSON.stringify(report);
      if (bytes + Buffer.byteLength(json) > BATCH_BYTES) flush();
      bytes += Buffer.byteLength(json);
      batch.push({
        file,
        signature,
        json,
        id: report.id,
        timestamp: `${report.date}T${report.time}`,
        line: report.line,
        aggregate: Number(report.isAggregate),
        detailCount: report.testResults.length + report.segmentInfoList.length,
      });
      progress.indexed += 1;
    } catch (error) {
      if (!current(scope, version) || error.code === "ENOENT") return;
      // Access errors are not stable invalid report contents; retry on the next reconciliation.
      if (error.code) {
        safeToPrune = false;
        scope.failed = error;
        recordError(file, error);
        return;
      }
      batch.push({ file, signature, error: error.message });
      progress.invalid += 1;
      recordError(file, error);
    }
  }
  async function visit(file) {
    if (!current(scope, version) || excluded(file)) return;
    const relative = path.relative(scope.directory, file);
    const depth = relative ? relative.split(path.sep).length : 0;
    if (depth > 2) return;
    try {
      const stat = await authorized(file);
      if (stat.isDirectory()) {
        if (depth >= 2) return;
        const entries = await fs.opendir(file, { bufferSize: 32 });
        for await (const entry of entries) {
          if (!current(scope, version)) break;
          if (
            (depth === 0 && entry.isDirectory()) ||
            (depth === 1 && entry.isFile())
          )
            await visit(path.join(file, entry.name));
        }
      } else if (stat.isFile() && depth === 2) {
        await processFile(file, stat);
      }
      if (
        batch.length >= BATCH_FILES ||
        bytes >= BATCH_BYTES ||
        visitedSinceFlush >= BATCH_FILES
      ) {
        flush();
        await new Promise((resolve) => setImmediate(resolve));
        // Yield history work to queued live dates at every bounded indexing batch.
        if (scope.date < nextDay(localDay(), -1)) {
          for (const date of [localDay(), nextDay(localDay(), -1)]) {
            const live = active.get(date);
            if (live && (live.full || live.paths.size)) await processQueuedScope(live);
          }
        }
      }
    } catch (error) {
      if (current(scope, version) && error.code !== "ENOENT") {
        safeToPrune = false;
        scope.failed = error;
        recordError(file, error);
      }
    }
  }
  try {
    await authorized(scanRoot, true);
    scanErrors.delete(scanRoot);
    await visit(target);
    flush();
    if (safeToPrune && !deferred && current(scope, version)) {
      const prefix = `${target}${path.sep}`;
      while (current(scope, version)) {
        const stale = db
          .prepare(
            `SELECT path FROM report_files WHERE root=? AND scope=? AND generation<>?
          AND (path=? OR substr(path,1,?)=?) LIMIT ?`,
          )
          .all(
            scanRoot,
            scope.date,
            scanGeneration,
            target,
            prefix.length,
            prefix,
            BATCH_FILES,
          );
        if (!stale.length) break;
        transaction(db, () => {
          let modifications = 0;
          for (const row of stale) {
            modifications += removeReport(row.path, scanRoot).changes;
            deleteFile.run(row.path, scanRoot);
          }
          changed(modifications);
        });
        publish();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (target === scope.directory || !safeToPrune || deferred)
      scope.scanSucceeded = safeToPrune && !deferred && current(scope, version);
  } catch (error) {
    if (current(scope, version)) {
      scope.failed = error;
      recordError(target, error);
    }
  }
  if (deferred && current(scope, version)) {
    clearTimeout(scope.retryTimer);
    scope.retryTimer = setTimeout(() => queue(scope), 1800);
  }
}

async function processQueuedScope(scope) {
  const targets = scope.full ? [scope.directory] : [...scope.paths];
  scope.full = false;
  scope.paths.clear();
  scope.failed = null;
  try {
    await attachScopeWatcher(scope);
    for (const target of targets) {
      if (active.get(scope.date) !== scope || closed) break;
      await scanScope(scope, target);
    }
  } catch (error) {
    scope.failed = error;
    scope.scanSucceeded = false;
    recordError(scope.directory, error);
  }
  if (!scope.full && !scope.paths.size && !scope.retryTimer) {
    scope.resolve?.();
    scope.resolve = null;
    scope.completion = null;
  }
}

async function pump() {
  if (pumping || closed) return;
  pumping = true;
  status.scanning = true;
  status.scanProgress = {
    phase: "indexing",
    visited: 0,
    indexed: 0,
    invalid: 0,
    changed: 0,
    parsed: 0,
    startedAt: new Date().toISOString(),
  };
  publish();
  let completedVersion;
  try {
    while (!closed) {
      const scope = [...active.values()].find(
        (item) => item.full || item.paths.size,
      );
      if (!scope) break;
      await processQueuedScope(scope);
      if (active.get(scope.date) === scope) completedVersion = rootVersion;
    }
  } finally {
    pumping = false;
    status.scanning = false;
    if (completedVersion === rootVersion)
      status.lastScan = new Date().toISOString();
    status.scanProgress.phase = closed ? "closed" : "idle";
    if (!closed) publish();
  }
}

function queryFilter(query, selected = false) {
  const { start, end } = shiftBounds(query.date, query.shift);
  return {
    sql: "root=? AND timestamp>=? AND timestamp<? AND (?=0 OR aggregate=0)",
    values: [
      root,
      start,
      end,
      Number(selected ? Boolean(query.excludeAggregate) : true),
    ],
  };
}
const ordering = "ORDER BY timestamp,id";

function queryReports(query) {
  const scopes = activate(query);
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 100);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  )
    throw httpError(400, "分页参数无效");
  const filter = queryFilter(query, true);
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM reports WHERE ${filter.sql}`)
    .get(...filter.values).count;
  const rows = db
    .prepare(
      `SELECT json FROM reports WHERE ${filter.sql} ${ordering} LIMIT ? OFFSET ?`,
    )
    .iterate(...filter.values, pageSize, (page - 1) * pageSize);
  let bytes = 0;
  const reports = [];
  for (const row of rows) {
    bytes += Buffer.byteLength(row.json);
    if (bytes > PAGE_BYTES)
      throw httpError(413, "本页明细过大，请减小每页报告数量");
    reports.push(JSON.parse(row.json));
  }
  return {
    reports,
    total,
    page,
    pageSize,
    root,
    revision,
    indexing: scopes.some((scope) => Boolean(scope.completion)),
  };
}

async function exportOpen({ query, selection }) {
  if (snapshots.size >= 2)
    throw httpError(429, "同时最多导出两个快照，请稍后重试");
  const version = rootVersion;
  const scopes = activate(query);
  for (const scope of scopes) if (!scope.completion) queue(scope);
  await pump();
  await Promise.all(scopes.map((scope) => scope.completion));
  if (
    closed ||
    version !== rootVersion ||
    scopes.some((scope) => active.get(scope.date) !== scope)
  ) {
    throw httpError(409, "报告目录或查询日期已变化，请重新导出");
  }
  if (scopes.some((scope) => scope.failed))
    throw httpError(503, "报告日期目录未完整读取，请检查扫描状态后重试导出");
  if (snapshots.size >= 2)
    throw httpError(429, "同时最多导出两个快照，请稍后重试");
  const connection = new DatabaseSync(workerData.database);
  connection.exec(
    "PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;",
  );
  try {
    const explicit =
      Array.isArray(selection.ids) || selection.allSelected === true;
    const filter = queryFilter(query, explicit);
    if (Array.isArray(selection.ids)) {
      connection.exec("CREATE TEMP TABLE selected_ids(id TEXT PRIMARY KEY)");
      const insert = connection.prepare(
        "INSERT OR IGNORE INTO selected_ids VALUES(?)",
      );
      transaction(connection, () => {
        for (const id of selection.ids) insert.run(id);
      });
      filter.sql += " AND id IN (SELECT id FROM selected_ids)";
    }
    connection.exec("BEGIN");
    const totals = connection
      .prepare(
        `SELECT COUNT(*) AS count,COALESCE(SUM(COALESCE(detail_count,
      json_array_length(json,'$.testResults')+json_array_length(json,'$.segmentInfoList'))),0) AS detailCount
      FROM reports WHERE ${filter.sql}`,
      )
      .get(...filter.values);
    if (
      Array.isArray(selection.ids) &&
      totals.count !== new Set(selection.ids).size
    )
      throw httpError(409, "部分选中报告已经变化，请刷新后重新选择");
    const statement = connection.prepare(
      `SELECT json FROM reports WHERE ${filter.sql} ${ordering}`,
    );
    const token = randomUUID();
    snapshots.set(token, {
      connection,
      statement,
      values: filter.values,
      iterator: null,
      touched: Date.now(),
    });
    return { token, ...totals };
  } catch (error) {
    connection.close();
    throw error;
  }
}

function exportClose(token) {
  const snapshot = snapshots.get(token);
  if (!snapshot) return;
  snapshots.delete(token);
  snapshot.iterator?.return();
  snapshot.connection.exec("ROLLBACK");
  snapshot.connection.close();
}

function exportNext(token, start) {
  const snapshot = snapshots.get(token);
  if (!snapshot) throw httpError(410, "导出快照已关闭或超时");
  snapshot.touched = Date.now();
  if (start) {
    if (snapshot.iterator) throw httpError(409, "同一导出快照不能并发读取");
    snapshot.iterator = snapshot.statement.iterate(...snapshot.values);
  }
  if (!snapshot.iterator) throw httpError(409, "导出读取尚未开始");
  const reports = [];
  let bytes = 0;
  let done = false;
  while (reports.length < 32 && bytes < BATCH_BYTES) {
    const next = snapshot.iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    bytes += Buffer.byteLength(next.value.json);
    reports.push(JSON.parse(next.value.json));
  }
  if (done) exportEnd(token);
  return { reports, done };
}

function exportEnd(token) {
  const snapshot = snapshots.get(token);
  if (!snapshot) return;
  snapshot.iterator?.return();
  snapshot.iterator = null;
  snapshot.touched = Date.now();
}

function deactivate() {
  rootVersion += 1;
  rootWatcher?.close();
  rootWatcher = null;
  clearTimeout(timer);
  timer = null;
  for (const scope of active.values()) {
    scope.watcher?.close();
    clearTimeout(scope.retryTimer);
    scope.resolve?.();
  }
  active.clear();
}

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function nextDay(date, offset = 1) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function markDiscovered(date) {
  if (!root || closed) return;
  try { shiftBounds(date, "day"); } catch { return; }
  try {
    db.prepare(`INSERT INTO sync_scan_dates(root,date,pending) VALUES(?,?,1)
      ON CONFLICT(root,date) DO UPDATE SET pending=1`).run(root, date);
  } catch (error) {
    recordError(root, error);
    publish();
  }
}

async function enqueueBaseline() {
  if (baselineRunning || closed || !readSyncConfig(db)?.configured) return;
  baselineRunning = true;
  let after = "";
  let configuration = getSetting(db, "syncConfig");
  try {
    while (!closed) {
      const currentConfiguration = getSetting(db, "syncConfig");
      if (currentConfiguration !== configuration) {
        configuration = currentConfiguration;
        after = "";
      }
      const row = db.prepare(`SELECT r.id,r.json FROM reports r
        LEFT JOIN sync_versions v ON v.report_id=r.id
        WHERE r.id>? AND (v.report_id IS NULL OR v.content_hash='') ORDER BY r.id LIMIT 1`).get(after);
      if (!row) break;
      transaction(db, () => enqueueReport(db, row.id, row.json, true));
      after = row.id;
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally { baselineRunning = false; }
}

async function acquireReports() {
  if (closed || acquisitionRunning || !root) return;
  acquisitionRunning = true;
  const scanRoot = root;
  const version = rootVersion;
  const valid = () => !closed && root === scanRoot && version === rootVersion;
  const key = `acquisition:${createHash("sha256").update(scanRoot).digest("hex")}`;
  try {
    enqueueBaseline().catch((error) => { if (!closed) { recordError(scanRoot, error); publish(); } });
    const today = localDay();
    const yesterday = nextDay(today, -1);
    const watermark = getSetting(db, key, yesterday);
    // A crash during the first live scan must not move the recovery starting date.
    if (!getSetting(db, key)) setSetting(db, key, watermark);
    // Persist each completed day, never a whole-range optimistic watermark.
    async function scanDay(date, historical = date < yesterday) {
      if (!valid()) return false;
      const [scope] = activate({ date, shift: "day" });
      scope.historical = historical;
      scope.scanSucceeded = false;
      queue(scope);
      await scope.completion;
      if (!valid() || active.get(date) !== scope || !scope.scanSucceeded || scope.failed) return false;
      db.prepare("UPDATE sync_scan_dates SET pending=0 WHERE root=? AND date=?").run(scanRoot, date);
      scope.historical = date < yesterday;
      return true;
    }
    // Streaming discovery records directory identities on disk, not a RAM history list.
    // On first use, old untouched directories are opt-in history, not an automatic years-long import.
    const discovered = getSetting(db, `${key}:discovered`) === "true";
    await authorized(scanRoot, true);
    const entries = await fs.opendir(scanRoot, { bufferSize: 32 });
    for await (const entry of entries) {
      if (!valid()) return;
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      try { shiftBounds(entry.name, "day"); } catch { continue; }
      db.prepare("INSERT OR IGNORE INTO sync_scan_dates(root,date,pending) VALUES(?,?,?)")
        .run(scanRoot, entry.name, Number(discovered));
    }
    if (!valid()) return;
    setSetting(db, `${key}:discovered`, "true");
    // Watch live dates before traversing a potentially months-long stopped-service gap.
    if (!await scanDay(today) || !await scanDay(yesterday)) return;
    for (let date = watermark < yesterday ? watermark : yesterday; date <= today; date = nextDay(date)) {
      if (!await scanDay(date)) return;
      setSetting(db, key, date);
    }
    while (valid()) {
      const row = db.prepare("SELECT date FROM sync_scan_dates WHERE root=? AND pending=1 AND date<=? ORDER BY date LIMIT 1")
        .get(scanRoot, today);
      if (!row) break;
      if (!await scanDay(row.date)) return;
    }
    while (valid()) {
      const row = db.prepare("SELECT date FROM sync_backfill WHERE root=? ORDER BY date LIMIT 1").get(scanRoot);
      if (!row) break;
      if (!await scanDay(row.date, true)) return;
      db.prepare("DELETE FROM sync_backfill WHERE root=? AND date=?").run(scanRoot, row.date);
      publish();
    }
  } catch (error) {
    if (valid()) { recordError(scanRoot, error); publish(); }
  } finally {
    acquisitionRunning = false;
    if (!closed && !valid()) setImmediate(() => acquireReports().catch(fatal));
  }
}

async function dispatch(method, params) {
  if (closed && method !== "close") throw httpError(503, "报告索引已关闭");
  if (method === "query") return queryReports(params);
  if (method === "syncConfigure") {
    enqueueBaseline().catch((error) => { recordError(root, error); publish(); });
    return;
  }
  if (method === "syncBackfill") {
    if (!root) throw httpError(400, "请先选择本地报告目录");
    const { from, to } = validateBackfillRange(params);
    let scheduled = 0;
    transaction(db, () => {
      const insert = db.prepare("INSERT OR IGNORE INTO sync_backfill(root,date) VALUES(?,?)");
      for (let date = from; date <= to; date = nextDay(date)) scheduled += insert.run(root, date).changes;
    });
    acquireReports().catch(fatal);
    return { from, to, scheduled };
  }
  if (method === "exportOpen") return exportOpen(params);
  if (method === "exportNext") return exportNext(params.token, params.start);
  if (method === "exportClose") return exportClose(params.token);
  if (method === "exportEnd") return exportEnd(params.token);
  if (method === "setRoot") {
    if (root === params.root) return root;
    deactivate();
    root = params.root;
    transaction(db, () => {
      setSetting(db, "dataPath", root);
      revision += 1;
      setSetting(db, "revision", revision);
    });
    status.lastScan = null;
    status.errors = [];
    scanErrors.clear();
    status.scanProgress = {
      phase: "idle",
      visited: 0,
      indexed: 0,
      invalid: 0,
      changed: 0,
      parsed: 0,
      startedAt: null,
    };
    await attachRootWatcher();
    acquireReports().catch(fatal);
    publish();
    return root;
  }
  if (method === "scan") {
    for (const scope of active.values()) queue(scope);
    await pump();
    await Promise.all([...active.values()].map((scope) => scope.completion));
    return;
  }
  if (method === "close") {
    closed = true;
    deactivate();
    clearInterval(reconcile);
    clearInterval(expiry);
    clearInterval(acquisition);
    for (const token of snapshots.keys()) exportClose(token);
    return;
  }
  throw httpError(400, "未知报告操作");
}

function fatal(error) {
  throw error;
}

const reconcile = setInterval(
  () => {
    for (const scope of active.values()) queue(scope);
  },
  10 * 60 * 1000,
);
reconcile.unref();
const expiry = setInterval(() => {
  for (const [token, snapshot] of snapshots)
    if (Date.now() - snapshot.touched > 120000) exportClose(token);
}, 30000);
expiry.unref();
const acquisition = setInterval(() => { acquireReports().catch(fatal); }, 60000);
acquisition.unref();
parentPort.on("message", ({ id, method, params }) => {
  Promise.resolve()
    .then(() => dispatch(method, params))
    .then(
      (result) => parentPort.postMessage({ id, result }),
      (error) =>
        parentPort.postMessage({
          id,
          error: { message: error.message, status: error.status },
        }),
    );
});
await attachRootWatcher();
publish();
parentPort.postMessage({ type: "ready" });
acquireReports().catch(fatal);
