import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export function openDatabase(home) {
  const db = new DatabaseSync(path.join(home, "lizi.sqlite"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS login_attempts (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      path TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      timestamp TEXT NOT NULL, line REAL, aggregate INTEGER NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_timestamp ON reports(timestamp);
    INSERT OR IGNORE INTO settings(key,value) VALUES ('revision','0');
    INSERT OR IGNORE INTO settings(key,value) VALUES ('authenticationEnabled','false');
  `);
  return db;
}

export function getSetting(db, key, fallback = "") {
  return (
    db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ??
    fallback
  );
}

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, String(value));
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
