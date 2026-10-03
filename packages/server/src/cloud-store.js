import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { shiftBounds } from "@lizi/core";
import { databaseLocation, transaction } from "./database.js";
import { httpError } from "./directories.js";

const publicColumns = "id,name,instrument_id,instrument_type,revoked,last_seen_at,last_received_at,pending,oldest_pending_at,last_error";
export function publicDevice(row) {
  return { id: row.id, name: row.name, instrumentId: row.instrument_id, instrumentType: row.instrument_type, revoked: Boolean(row.revoked), lastSeenAt: row.last_seen_at, lastReceivedAt: row.last_received_at, pending: row.pending, oldestPendingAt: row.oldest_pending_at, lastError: row.last_error };
}

export function initializeCloud(db) {
  db.exec(`
    PRAGMA synchronous=FULL;
    PRAGMA temp_store=FILE;
    CREATE TABLE IF NOT EXISTS cloud_devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instrument_id TEXT NOT NULL,
      instrument_type TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      revoked INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, last_received_at TEXT,
      pending INTEGER, oldest_pending_at TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS cloud_versions (
      device_id TEXT NOT NULL REFERENCES cloud_devices(id), report_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, id TEXT NOT NULL, content_hash TEXT NOT NULL, version_hash TEXT NOT NULL,
      instrument_id TEXT NOT NULL, instrument_type TEXT NOT NULL, schema_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL, occurred_at TEXT NOT NULL, historical INTEGER NOT NULL,
      received_at TEXT NOT NULL, timestamp TEXT NOT NULL, aggregate INTEGER NOT NULL,
      detail_count INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(device_id,report_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS cloud_receipts (
      device_id TEXT NOT NULL REFERENCES cloud_devices(id), event_id TEXT NOT NULL,
      report_id TEXT NOT NULL, sequence INTEGER NOT NULL, content_hash TEXT NOT NULL,
      version_hash TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(device_id,event_id),
      FOREIGN KEY(device_id,report_id,sequence) REFERENCES cloud_versions(device_id,report_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS cloud_current (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, report_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      UNIQUE(device_id,report_id),
      FOREIGN KEY(device_id,report_id,sequence) REFERENCES cloud_versions(device_id,report_id,sequence)
    );
    CREATE INDEX IF NOT EXISTS cloud_versions_timestamp ON cloud_versions(timestamp);
    CREATE TABLE IF NOT EXISTS cloud_state (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO cloud_state VALUES(1,0);
  `);
}

const joins = `FROM cloud_current c
  JOIN cloud_versions v ON v.device_id=c.device_id AND v.report_id=c.report_id AND v.sequence=c.sequence
  JOIN cloud_devices d ON d.id=c.device_id`;
const ordering = "ORDER BY v.timestamp,c.id";
const columns = "v.json,c.id,v.instrument_id,v.instrument_type,v.schema_version,v.parser_version,d.id AS source_id,d.name AS source_name";
function reportRow(row) {
  return { ...JSON.parse(row.json), id: row.id, sourceId: row.source_id, sourceName: row.source_name, instrumentId: row.instrument_id, instrumentType: row.instrument_type, schemaVersion: row.schema_version, parserVersion: row.parser_version };
}
function filter(query, explicit = true) {
  let bounds;
  try { bounds = shiftBounds(query.date, query.shift); }
  catch (error) { throw httpError(400, error.message); }
  return { sql: "v.timestamp>=? AND v.timestamp<? AND (?=0 OR v.aggregate=0)", values: [bounds.start, bounds.end, Number(explicit ? Boolean(query.excludeAggregate) : true)] };
}

export class CloudStore extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.location = databaseLocation(db);
    this.root = "server";
    this.errors = [];
    this.closed = false;
    this.revision = db.prepare("SELECT revision FROM cloud_state WHERE id=1").get().revision;
    this.offlineAfter = options.offlineAfterMs ?? 120000;
    this.snapshots = new Set();
    this.expiry = setInterval(() => {
      for (const snapshot of this.snapshots)
        if (Date.now() - snapshot.touched > 120000) snapshot.close();
    }, 30000);
    this.expiry.unref();
  }

  assertOpen() { if (this.closed) throw httpError(503, "中心报告存储已关闭"); }
  async start() { this.assertOpen(); }
  devices() { return this.db.prepare(`SELECT ${publicColumns} FROM cloud_devices ORDER BY name,id`).all().map(publicDevice); }
  coverage() {
    const warnings = ["中心仅显示已上传数据；即使待上传为 0，也不能据此确认源目录和历史数据完整。"];
    const now = Date.now();
    const sources = this.devices().map((device) => {
      const offline = !device.lastSeenAt || now - Date.parse(device.lastSeenAt) > this.offlineAfter;
      let state = "ready";
      if (device.revoked) state = "revoked";
      else if (offline) state = "offline";
      else if (device.lastError) state = "error";
      else if (device.pending > 0) state = "syncing";
      if (device.revoked) warnings.push(`${device.name}：设备已撤销，保留此前上传数据`);
      else if (offline) warnings.push(`${device.name}：设备离线或尚未连接，数据可能不完整`);
      if (device.pending > 0) warnings.push(`${device.name}：还有 ${device.pending} 份待上传报告`);
      if (device.lastError) warnings.push(`${device.name}：上传发生错误，请检查设备状态`);
      return { ...device, state, connected: !offline && !device.revoked, complete: false };
    });
    return { sources, warnings, transient: false };
  }
  status() {
    this.assertOpen();
    return { root: this.root, revision: this.revision, reportCount: this.db.prepare("SELECT COUNT(*) AS count FROM cloud_current").get().count, watching: false, scanning: false, indexing: false, errors: [], ...this.coverage() };
  }
  changed(revision) {
    if (revision !== this.revision) {
      this.revision = revision;
      this.emit("revision", { revision });
    }
    this.emit("status", this.status());
  }

  async query(query) {
    this.assertOpen();
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 100);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw httpError(400, "分页参数无效");
    const selected = filter(query);
    const total = this.db.prepare(`SELECT COUNT(*) AS count ${joins} WHERE ${selected.sql}`).get(...selected.values).count;
    const rows = this.db.prepare(`SELECT ${columns} ${joins} WHERE ${selected.sql} ${ordering} LIMIT ? OFFSET ?`).iterate(...selected.values, pageSize, (page - 1) * pageSize);
    let bytes = 0;
    const reports = [];
    for (const row of rows) {
      bytes += Buffer.byteLength(row.json);
      if (bytes > 8 * 1024 * 1024) throw httpError(413, "本页明细过大，请减小每页报告数量");
      reports.push(reportRow(row));
    }
    return { reports, total, page, pageSize, root: this.root, revision: this.revision, indexing: false, errors: [], ...this.coverage() };
  }

  async exportSnapshot(query, selection = {}) {
    this.assertOpen();
    if (this.snapshots.size >= 2) throw httpError(429, "同时最多导出两个快照，请稍后重试");
    if (selection.ids !== undefined && (!Array.isArray(selection.ids) || selection.ids.length > 10000 || selection.ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)))) throw httpError(400, "导出选择无效");
    const selected = filter(query, Array.isArray(selection.ids) || selection.allSelected === true);
    const connection = new DatabaseSync(this.location);
    const store = this;
    let snapshot;
    try {
      connection.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;");
      if (Array.isArray(selection.ids)) {
        connection.exec("CREATE TEMP TABLE selected_ids(id TEXT PRIMARY KEY)");
        const insert = connection.prepare("INSERT OR IGNORE INTO selected_ids VALUES(?)");
        transaction(connection, () => { for (const id of selection.ids) insert.run(id); });
        selected.sql += " AND c.id IN (SELECT id FROM selected_ids)";
      }
      connection.exec("BEGIN");
      const totals = connection.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(v.detail_count),0) AS detailCount ${joins} WHERE ${selected.sql}`).get(...selected.values);
      if (Array.isArray(selection.ids) && totals.count !== new Set(selection.ids).size) throw httpError(409, "部分选中报告已经变化，请刷新后重新选择");
      if (totals.detailCount > 500000) throw httpError(413, "测试明细超过50万行，请分批选择导出");
      const statement = connection.prepare(`SELECT ${columns} ${joins} WHERE ${selected.sql} ${ordering}`);
      snapshot = {
        touched: Date.now(), closed: false, iterator: null,
        close() {
          if (snapshot.closed) return;
          snapshot.closed = true;
          snapshot.iterator?.return();
          snapshot.iterator = null;
          store.snapshots.delete(snapshot);
          try { connection.exec("ROLLBACK"); } finally { connection.close(); }
        },
      };
      this.snapshots.add(snapshot);
      const reports = {
        async *[Symbol.asyncIterator]() {
          if (snapshot.closed) throw httpError(410, "导出快照已关闭或超时");
          if (snapshot.iterator) throw httpError(409, "同一导出快照不能并发读取");
          snapshot.iterator = statement.iterate(...selected.values);
          let count = 0;
          try {
            while (true) {
              if (snapshot.closed) throw httpError(410, "导出快照已关闭或超时");
              snapshot.touched = Date.now();
              const next = snapshot.iterator.next();
              if (next.done) break;
              yield reportRow(next.value);
              if (++count % 32 === 0) await setImmediate();
            }
          } finally {
            snapshot.iterator?.return();
            snapshot.iterator = null;
            snapshot.touched = Date.now();
          }
        },
      };
      return { ...totals, reports, close: snapshot.close };
    } catch (error) {
      if (snapshot) snapshot.close();
      else connection.close();
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.expiry);
    for (const snapshot of this.snapshots) snapshot.close();
  }
}
