import { createHash, randomUUID } from "node:crypto";
import { shiftBounds } from "@lizi/core";
import { httpError } from "./directories.js";
import { getSetting, setSetting } from "./database.js";

export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
export const instrumentAdapters = Object.freeze({
  strength(report, config) {
    return { ...report, instrumentId: config.instrumentId, instrumentType: "strength", schemaVersion: 1 };
  },
});

export function validateBackfillRange(input) {
  const { from, to } = input ?? {};
  try { shiftBounds(from, "day"); shiftBounds(to, "day"); }
  catch { throw httpError(400, "历史补传日期必须为有效的 YYYY-MM-DD"); }
  const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000 + 1;
  if (!Number.isInteger(days) || days < 1 || days > 3660)
    throw httpError(400, "历史补传日期范围必须按先后顺序且不超过 3660 天");
  return { from, to, days };
}

// Called on both connections before statements are prepared. Never cache configuration:
// BEGIN IMMEDIATE serializes configuration changes with indexing transactions.
export function initializeOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_versions (
      report_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      event_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      content_hash TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_outbox_order ON sync_outbox(created_at,event_id);
    CREATE TABLE IF NOT EXISTS sync_scan_dates (
      root TEXT NOT NULL, date TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(root,date)
    );
    CREATE TABLE IF NOT EXISTS sync_backfill (
      root TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(root,date)
    );
  `);
}

export function readSyncConfig(db) {
  return JSON.parse(getSetting(db, "syncConfig", "null"));
}

// Must run inside the same transaction as the local report write.
export function enqueueReport(db, reportId, json, historical = false) {
  const config = readSyncConfig(db);
  if (!config?.configured) return false;
  const report = instrumentAdapters[config.instrumentType](JSON.parse(json), config);
  const contentHash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const previous = db.prepare("SELECT sequence,content_hash FROM sync_versions WHERE report_id=?").get(reportId);
  if (previous?.content_hash === contentHash) return false;
  const sequence = (previous?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("报告上传版本已超出安全范围");
  const now = new Date().toISOString();
  const event = { eventId: randomUUID(), reportId, sequence, contentHash,
    instrumentId: config.instrumentId, instrumentType: config.instrumentType,
    schemaVersion: 1, parserVersion: 2, occurredAt: now, historical, report };
  const payload = JSON.stringify(event);
  db.prepare(`INSERT INTO sync_versions VALUES(?,?,?) ON CONFLICT(report_id)
    DO UPDATE SET sequence=excluded.sequence,content_hash=excluded.content_hash`).run(reportId, sequence, contentHash);
  db.prepare("INSERT INTO sync_outbox VALUES(?,?,?,?,?,?,?)")
    .run(event.eventId, reportId, sequence, contentHash, payload, Buffer.byteLength(payload), now);
  setSetting(db, "syncIdentityLocked", "true");
  return true;
}
