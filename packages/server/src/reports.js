import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import { decodeReport, parseReport, shiftBounds } from "@lizi/core";
import { getSetting, setSetting, transaction } from "./database.js";
import { httpError, isWithin } from "./directories.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 100000;
const MAX_REPORTS = 20000;
const fingerprint = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

export class ReportStore extends EventEmitter {
  constructor(db, directories) {
    super();
    this.db = db;
    this.directories = directories;
    this.root = getSetting(db, "dataPath");
    this.revision = Number(getSetting(db, "revision", "0"));
    this.scanning = false;
    this.watching = false;
    this.lastScan = null;
    this.errors = [];
    this.tail = Promise.resolve();
    this.closed = false;
    this.watcher = null;
    this.scanPromise = null;
    this.timer = null;
    this.poll = null;
  }

  enqueue(action) {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  async start() {
    if (this.root) {
      await this.attachWatcher();
      await this.scan();
    }
    if (this.closed) return;
    this.poll = setInterval(() => this.schedule(0), 30000);
    this.poll.unref();
  }

  status() {
    return {
      revision: this.revision,
      reportCount: this.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n,
      watching: this.watching,
      scanning: this.scanning,
      lastScan: this.lastScan,
      errors: this.errors,
    };
  }

  bump() {
    this.revision += 1;
    setSetting(this.db, "revision", this.revision);
  }

  notify() {
    this.emit("revision", { revision: this.revision });
  }

  schedule(delay = 700) {
    if (this.closed || !this.root) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan().catch((error) => {
        this.errors = [{ path: this.root, message: error.message }];
        this.notify();
      });
    }, delay);
    this.timer.unref();
  }

  async attachWatcher() {
    if (this.watcher) await this.watcher.close();
    this.watching = false;
    this.watcher = null;
    if (!this.root || this.closed) return;
    try {
      await this.directories.resolveDirectory(this.root);
      const watcher = chokidar.watch(this.root, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
        atomic: true,
      });
      this.watcher = watcher;
      watcher.on("ready", () => {
        if (this.watcher === watcher) {
          this.watching = true;
          this.notify();
        }
      });
      watcher.on("all", () => this.schedule());
      watcher.on("error", (error) => {
        this.watching = false;
        this.errors = [
          {
            path: this.root,
            message: `实时监控异常，定时补扫仍启用：${error.message}`,
          },
        ];
        this.notify();
      });
    } catch (error) {
      this.errors = [{ path: this.root, message: error.message }];
    }
  }

  setRoot(root) {
    return this.enqueue(async () => {
      const canonical = await this.directories.resolveDirectory(root);
      if (canonical !== this.root) {
        if (this.watcher) await this.watcher.close();
        this.watcher = null;
        this.watching = false;
        transaction(this.db, () => {
          this.db.exec("DELETE FROM reports");
          setSetting(this.db, "dataPath", canonical);
          this.bump();
        });
        this.root = canonical;
        this.lastScan = null;
        this.errors = [];
        this.notify();
      }
      await this.attachWatcher();
      await this.performScan();
      return canonical;
    });
  }

  scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.enqueue(() => this.performScan()).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async performScan() {
    if (this.closed || !this.root) return;
    this.scanning = true;
    this.notify();
    const root = this.root;
    const errors = [];
    const recordError = (file, error) => {
      if (errors.length < 200)
        errors.push({ path: file, message: error.message });
    };
    const seen = new Set();
    const protectedPrefixes = [];
    const updates = [];
    const invalid = new Set();
    let deferred = false;
    let visited = 0;
    const cached = new Map(
      this.db
        .prepare("SELECT path,fingerprint FROM reports")
        .all()
        .map((row) => [row.path, row.fingerprint]),
    );
    const visit = async (directory) => {
      let entries;
      try {
        const actual = await fs.realpath(directory);
        if (!isWithin(root, actual))
          throw new Error("目录链接超出报告根，已拒绝读取");
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        protectedPrefixes.push(directory);
        recordError(directory, error);
        return;
      }
      for (const entry of entries) {
        if (this.closed) return;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(file);
          continue;
        }
        if (!entry.isFile()) continue;
        visited += 1;
        if (visited > MAX_FILES)
          throw new Error(`报告文件数超过 ${MAX_FILES}，请缩小报告目录`);
        seen.add(file);
        try {
          const actual = await fs.realpath(file);
          if (!isWithin(root, actual))
            throw new Error("文件链接超出报告根，已拒绝读取");
          const stat = await fs.stat(actual);
          const signature = fingerprint(stat);
          if (cached.get(file) === signature) continue;
          if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过8 MiB上限");
          if (Date.now() - stat.mtimeMs < 1500) {
            deferred = true;
            continue;
          }
          // Open the canonical path and compare the handle with both pre/post path identities.
          const handle = await fs.open(actual, "r");
          let buffer;
          try {
            const opened = await handle.stat();
            if (fingerprint(opened) !== signature || !opened.isFile()) {
              deferred = true;
              continue;
            }
            buffer = Buffer.allocUnsafe(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
              const { bytesRead } = await handle.read(
                buffer,
                length,
                buffer.length - length,
                length,
              );
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length !== stat.size) {
              deferred = true;
              continue;
            }
            buffer = buffer.subarray(0, length);
            if (fingerprint(await handle.stat()) !== signature) {
              deferred = true;
              continue;
            }
          } finally {
            await handle.close();
          }
          if (
            (await fs.realpath(file)) !== actual ||
            fingerprint(await fs.stat(file)) !== signature
          ) {
            deferred = true;
            continue;
          }
          const report = parseReport(decodeReport(buffer));
          report.id = createHash("sha256")
            .update(`${root}\0${path.relative(root, file)}`)
            .digest("hex")
            .slice(0, 32);
          updates.push({ file, signature, report });
        } catch (error) {
          if (error.code === "ENOENT") {
            seen.delete(file);
            continue;
          }
          recordError(file, error);
          invalid.add(file);
        }
      }
    };
    try {
      const authorized = await this.directories.resolveDirectory(root);
      if (authorized !== root)
        throw new Error("报告根目录链接已改变，请重新选择目录");
      await visit(root);
      const remove = [...cached.keys()].filter(
        (file) =>
          invalid.has(file) ||
          (!seen.has(file) &&
            !protectedPrefixes.some((directory) => isWithin(directory, file))),
      );
      if (updates.length || remove.length) {
        transaction(this.db, () => {
          const upsert = this.db
            .prepare(`INSERT INTO reports(path,id,fingerprint,timestamp,line,aggregate,json) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET id=excluded.id,fingerprint=excluded.fingerprint,timestamp=excluded.timestamp,
            line=excluded.line,aggregate=excluded.aggregate,json=excluded.json`);
          for (const { file, signature, report } of updates) {
            upsert.run(
              file,
              report.id,
              signature,
              `${report.date}T${report.time}`,
              report.line,
              Number(report.isAggregate),
              JSON.stringify(report),
            );
          }
          const deletion = this.db.prepare("DELETE FROM reports WHERE path=?");
          for (const file of remove) deletion.run(file);
          this.bump();
        });
      }
      this.lastScan = new Date().toISOString();
    } catch (error) {
      recordError(root, error);
      // An unreachable root is not evidence that all reports were deleted.
    } finally {
      this.errors = errors;
      this.scanning = false;
      this.notify();
      if (deferred) this.schedule(1700);
      if (!this.watching && !this.closed) await this.attachWatcher();
    }
  }

  query({ date, shift, excludeAggregate }) {
    const { start, end } = shiftBounds(date, shift);
    const rows = this.db
      .prepare(
        `SELECT json FROM reports WHERE timestamp>=? AND timestamp<? AND (?=0 OR aggregate=0)
      ORDER BY line IS NULL, line, timestamp, id LIMIT ?`,
      )
      .all(start, end, Number(excludeAggregate), MAX_REPORTS + 1);
    if (rows.length > MAX_REPORTS)
      throw httpError(413, `当前班次超过 ${MAX_REPORTS} 份报告，请缩小范围`);
    return rows.map((row) => JSON.parse(row.json));
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    if (this.watcher) await this.watcher.close();
    await this.tail;
    this.watching = false;
  }
}
