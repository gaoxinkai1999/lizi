import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { getSetting, setSetting, transaction } from "./database.js";
import { httpError } from "./directories.js";
import { initializeOutbox, readSyncConfig, instrumentAdapters, validateBackfillRange, MAX_EVENT_BYTES, MAX_BATCH_BYTES } from "./sync-outbox.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMANENT = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422]);
const MAX_DELAY = 300000;

export function normalizeServerUrl(value, allowLoopbackHttp = false) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw httpError(400, "服务器地址无效"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback))
    throw httpError(400, "上传服务器必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value))
    throw httpError(400, "服务器地址不能包含账号、查询参数或片段");
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function exactAcknowledgements(body, deviceId, events) {
  if (!body || body.protocolVersion !== 1 || body.deviceId !== deviceId || !Array.isArray(body.acknowledgements))
    return [];
  if (body.acknowledgements.length > events.length) return [];
  const sent = new Map(events.map((event) => [event.eventId, event]));
  const matched = new Set();
  for (const ack of body.acknowledgements) {
    const event = ack && sent.get(ack.eventId);
    if (!event || matched.has(ack.eventId) || ack.reportId !== event.reportId ||
        ack.sequence !== event.sequence || ack.contentHash !== event.contentHash) return [];
    matched.add(ack.eventId);
  }
  return [...matched];
}

function retryAfter(value) {
  if (!value) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(MAX_DELAY, Math.max(0, delay)) : 0;
}

class SyncClient extends EventEmitter {
  constructor({ home, db, localStore, options }) {
    super();
    this.db = db;
    this.localStore = localStore;
    this.options = options;
    this.credentialsPath = path.join(home, "sync-credentials.json");
    initializeOutbox(db);
    this.config = readSyncConfig(db) ?? { enabled: false, serverUrl: "", deviceId: options.deviceId ?? randomUUID(),
      instrumentId: options.deviceId ?? "", instrumentType: "strength", configured: false };
    if (!this.config.instrumentId) this.config.instrumentId = this.config.deviceId;
    if (!UUID.test(this.config.deviceId) || (options.deviceId && options.deviceId !== this.config.deviceId))
      throw httpError(409, "上传设备标识必须与本地设备标识一致");
    normalizeServerUrl(this.config.serverUrl, options.allowLoopbackHttp);
    setSetting(db, "syncConfig", JSON.stringify(this.config));
    this.credentials = null;
    try {
      this.credentials = JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
      fs.chmodSync(this.credentialsPath, 0o600);
    } catch {
      // A missing/unreadable secret must stop uploading, not local acquisition.
      this.credentials = null;
    }
    this.state = JSON.parse(getSetting(db, "syncState", "null")) ?? {
      lastSuccessAt: null, nextAttemptAt: null, lastError: null, paused: false, attempts: 0,
    };
    if (this.config.enabled && !this.token()) {
      this.state.lastError = "无法读取设备令牌，请重新保存上传凭据";
      this.state.paused = true;
      this.state.authFailed = true;
    }
    this.connected = false;
    this.requests = new Set();
    this.generation = 0;
    this.closed = false;
    this.started = false;
    this.queueMetrics = { pending: null, oldestPendingAt: null, backfillPendingDays: null };
    this.onLocalStatus = () => this.emitStatus();
    this.onRevision = () => { this.emitStatus(); this.kick(); };
  }

  token() {
    return this.credentials?.serverUrl === this.config.serverUrl && this.credentials?.deviceId === this.config.deviceId
      ? this.credentials.token : "";
  }

  getSettings() {
    const { enabled, serverUrl, deviceId, instrumentId, instrumentType } = this.config;
    return { enabled, serverUrl, deviceId, tokenConfigured: Boolean(this.token()), instrumentId, instrumentType };
  }

  getStatus() {
    let queueMetricsStale = false;
    try {
      this.queueMetrics = this.db.prepare(`SELECT COUNT(*) AS pending,MIN(created_at) AS oldestPendingAt,
        (SELECT COUNT(*) FROM sync_backfill) AS backfillPendingDays FROM sync_outbox`).get();
    } catch {
      queueMetricsStale = true;
      this.connected = false;
      this.state.paused = true;
      this.state.lastError = "上传队列读取失败，请检查磁盘空间和权限；显示最后已知队列状态";
    }
    if (this.config.enabled && !this.token()) {
      this.state.lastError = "上传凭据缺失或与当前服务器不匹配，请重新保存设备令牌";
      this.state.paused = true;
      this.state.authFailed = true;
    }
    const acquisitionError = this.localStore.failure || this.localStore.status?.().errors?.[0];
    return { enabled: this.config.enabled, connected: this.connected, ...this.queueMetrics, queueMetricsStale,
      lastSuccessAt: this.state.lastSuccessAt, nextAttemptAt: this.state.nextAttemptAt,
      lastError: this.state.lastError ?? (acquisitionError ? "本地采集异常，请检查目录权限、磁盘空间和报告索引状态" : null),
      paused: this.state.paused };
  }

  emitStatus() { if (!this.closed) this.emit("status", this.getStatus()); }

  saveState() {
    setSetting(this.db, "syncState", JSON.stringify(this.state));
    this.emitStatus();
  }

  async start() {
    if (this.closed || this.started) return;
    this.started = true;
    await this.localStore.syncConfigure();
    if (this.closed) return;
    this.localStore.on("revision", this.onRevision);
    this.localStore.on("status", this.onLocalStatus);
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 60000);
    this.heartbeatTimer.unref();
    this.kick();
    this.heartbeat();
  }

  async configure(input) {
    if (this.closed) throw httpError(503, "上传服务已关闭");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "上传设置无效");
    const next = { ...this.config };
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw httpError(400, "启用状态无效");
      next.enabled = input.enabled;
    }
    if (input.serverUrl !== undefined) {
      if (typeof input.serverUrl !== "string") throw httpError(400, "服务器地址无效");
      next.serverUrl = normalizeServerUrl(input.serverUrl, this.options.allowLoopbackHttp);
    }
    if (input.deviceId !== undefined && input.deviceId !== this.config.deviceId)
      throw httpError(409, "设备标识不可更改，请在服务器登记此设备标识");
    if (input.instrumentId !== undefined) next.instrumentId = input.instrumentId;
    if (typeof next.instrumentId !== "string" || !next.instrumentId.trim() || next.instrumentId.length > 128 || /[\x00-\x1f\x7f]/.test(next.instrumentId))
      throw httpError(400, "仪器标识必须为 1–128 个有效字符");
    if (input.instrumentType !== undefined) next.instrumentType = input.instrumentType;
    if (!Object.hasOwn(instrumentAdapters, next.instrumentType)) throw httpError(400, "目前仅支持强力仪 strength");
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input.token)))
      throw httpError(400, "设备令牌无效");
    const endpointChanged = next.serverUrl !== this.config.serverUrl;
    const token = input.token || (!endpointChanged ? this.token() : "");
    if (next.enabled && (!next.serverUrl || !token)) throw httpError(400, "启用上传前请配置服务器和设备令牌");
    next.configured = this.config.configured || Boolean(next.serverUrl && token);
    const previousCredentials = this.credentials;
    const credentials = { serverUrl: next.serverUrl, deviceId: next.deviceId, token };
    let wroteCredentials = false;
    try {
      transaction(this.db, () => {
        if (endpointChanged && this.db.prepare("SELECT 1 FROM sync_outbox LIMIT 1").get())
          throw httpError(409, "队列尚未排空，不能更换上传服务器；请先恢复原服务器并完成上传");
        if (getSetting(this.db, "syncIdentityLocked") === "true" && next.instrumentId !== this.config.instrumentId)
          throw httpError(409, "已有上传记录，仪器标识不可更改");
        this.writeCredentials(credentials);
        wroteCredentials = true;
        setSetting(this.db, "syncConfig", JSON.stringify(next));
        if (endpointChanged) this.db.exec("UPDATE sync_versions SET content_hash=''");
        setSetting(this.db, "syncState", JSON.stringify({ ...this.state, nextAttemptAt: null, lastError: null, paused: false, authFailed: false, attempts: 0 }));
      });
    } catch (error) {
      if (wroteCredentials) this.writeCredentials(previousCredentials);
      throw error;
    }
    this.generation += 1;
    for (const request of this.requests) request.destroy(new Error("configuration changed"));
    this.config = next;
    this.credentials = credentials;
    this.connected = false;
    Object.assign(this.state, { nextAttemptAt: null, lastError: null, paused: false, authFailed: false, attempts: 0 });
    await this.localStore.syncConfigure();
    this.emitStatus();
    this.kick();
    this.heartbeat();
    return this.getSettings();
  }

  writeCredentials(credentials) {
    const temporary = `${this.credentialsPath}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, "w", 0o600);
      try {
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(credentials));
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.credentialsPath);
      fs.chmodSync(this.credentialsPath, 0o600);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* May not exist. */ }
      throw httpError(500, "无法安全保存上传凭据，请检查磁盘空间和权限");
    }
  }

  async retry() {
    if (this.closed) throw httpError(503, "上传服务已关闭");
    Object.assign(this.state, { nextAttemptAt: null, lastError: null, paused: false, authFailed: false, attempts: 0 });
    this.saveState();
    this.kick();
    this.heartbeat();
    return this.getStatus();
  }

  async backfill(input) {
    if (this.closed) throw httpError(503, "上传服务已关闭");
    if (!this.config.configured) throw httpError(400, "请先配置上传服务器和设备令牌");
    const { from, to } = validateBackfillRange(input);
    const scheduled = await this.localStore.syncBackfill({ from, to });
    this.emitStatus();
    return { ...scheduled, status: this.getStatus() };
  }

  canSend() { return this.started && !this.closed && this.config.enabled && this.config.serverUrl && this.token(); }

  post(route, body) {
    const payload = JSON.stringify(body);
    const url = new URL(`${this.config.serverUrl}/api/ingest/${route}`);
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, { method: "POST", rejectUnauthorized: true,
        headers: { authorization: `Bearer ${this.token()}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
      this.requests.add(request);
      const timer = setTimeout(() => request.destroy(new Error("request timeout")), 15000);
      timer.unref();
      const finish = () => { clearTimeout(timer); this.requests.delete(request); };
      request.on("error", (error) => { finish(); reject(error); });
      request.on("response", (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 128 * 1024) request.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        response.on("error", (error) => { finish(); reject(error); });
        response.on("end", () => {
          finish();
          let json;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
          resolve({ status: response.statusCode, body: json, retryAfter: retryAfter(response.headers["retry-after"]) });
        });
      });
      request.end(payload);
    });
  }

  failure(message, permanent = false, minimumDelay = 0, authFailed = false) {
    this.connected = false;
    if (!this.state.authFailed || authFailed) this.state.lastError = message;
    this.state.authFailed = Boolean(this.state.authFailed || authFailed);
    permanent ||= this.state.authFailed;
    this.state.paused = permanent;
    this.state.attempts = Math.min(20, this.state.attempts + 1);
    const delay = Math.min(MAX_DELAY, Math.max(minimumDelay,
      Math.min(MAX_DELAY, 2000 * 2 ** (this.state.attempts - 1)) * (1 + Math.random() * 0.25)));
    this.state.nextAttemptAt = permanent ? null : new Date(Date.now() + delay).toISOString();
    this.saveState();
  }

  kick() {
    if (!this.canSend() || this.flight || this.state.paused || Date.parse(this.state.nextAttemptAt) > Date.now()) return;
    this.flight = this.send().catch(() => {
      // Persistence failure must remain visible; never acknowledge in memory only.
      this.connected = false;
      this.state.lastError = "上传队列写入失败，请检查磁盘空间和权限";
      this.state.paused = true;
      this.emitStatus();
    }).finally(() => { this.flight = null; });
  }

  async send() {
    const rows = this.db.prepare("SELECT event_id,bytes FROM sync_outbox ORDER BY created_at,event_id LIMIT 32").all();
    if (!rows.length) return;
    const events = [];
    let bytes = Buffer.byteLength(JSON.stringify({ protocolVersion: 1, deviceId: this.config.deviceId, events: [] }));
    for (const row of rows) {
      if (row.bytes > MAX_EVENT_BYTES) {
        if (!events.length) this.failure("报告超过服务器单条 1 MiB 限制；队列已保留，请处理后重试", true);
        break;
      }
      if (bytes + row.bytes + (events.length ? 1 : 0) > MAX_BATCH_BYTES) break;
      const stored = this.db.prepare("SELECT payload FROM sync_outbox WHERE event_id=?").get(row.event_id);
      events.push(JSON.parse(stored.payload));
      bytes += row.bytes + (events.length > 1 ? 1 : 0);
    }
    if (!events.length) return;
    const generation = this.generation;
    let response;
    try { response = await this.post("reports", { protocolVersion: 1, deviceId: this.config.deviceId, events }); }
    catch {
      if (!this.closed && generation === this.generation) this.failure("网络不可用或上传超时，报告已保留，稍后自动重试");
      return;
    }
    if (this.closed || generation !== this.generation) return;
    if (response.status !== 200) {
      this.failure(response.status === 401 || response.status === 403 ? "设备令牌无效或已撤销，请更新令牌" : `服务器拒绝上传（HTTP ${response.status}），报告已保留`,
        PERMANENT.has(response.status) || (response.status >= 300 && response.status < 400), response.retryAfter,
        response.status === 401 || response.status === 403);
      return;
    }
    const acknowledged = exactAcknowledgements(response.body, this.config.deviceId, events);
    if (!acknowledged.length) { this.failure("服务器确认无效，报告已保留，将以相同事件标识重试"); return; }
    const complete = acknowledged.length === events.length;
    const nextState = { ...this.state, lastSuccessAt: new Date().toISOString(), attempts: 0,
      nextAttemptAt: null, lastError: this.state.paused ? this.state.lastError : null };
    transaction(this.db, () => {
      const remove = this.db.prepare("DELETE FROM sync_outbox WHERE event_id=? AND report_id=? AND sequence=? AND content_hash=?");
      for (const id of acknowledged) {
        const event = events.find((item) => item.eventId === id);
        remove.run(id, event.reportId, event.sequence, event.contentHash);
      }
      setSetting(this.db, "syncState", JSON.stringify(nextState));
    });
    this.state = nextState;
    this.connected = true;
    if (!complete) this.failure("服务器仅确认部分报告，未确认的事件已保留");
    else this.emitStatus();
  }

  heartbeat() {
    if (!this.canSend() || this.heartbeatFlight || this.state.authFailed) return;
    const generation = this.generation;
    const status = this.getStatus();
    if (status.queueMetricsStale) return;
    this.heartbeatFlight = this.post("heartbeat", { protocolVersion: 1, deviceId: this.config.deviceId,
      pending: status.pending, oldestPendingAt: status.oldestPendingAt, lastError: status.lastError?.slice(0, 256) ?? null })
      .then((response) => {
        if (this.closed || generation !== this.generation) return;
        if (response.status === 401 || response.status === 403) this.failure("设备令牌无效或已撤销，请更新令牌", true, 0, true);
        else if (response.status >= 200 && response.status < 300) { this.connected = true; this.emitStatus(); }
      }).catch(() => {
        if (!this.closed && generation === this.generation) { this.connected = false; this.emitStatus(); }
      }).finally(() => { this.heartbeatFlight = null; });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    this.localStore.off("revision", this.onRevision);
    this.localStore.off("status", this.onLocalStatus);
    for (const request of this.requests) request.destroy(new Error("client closed"));
    await Promise.allSettled([this.flight, this.heartbeatFlight]);
  }
}

export async function createSyncClient({ home, db, localStore, options = {} }) {
  return new SyncClient({ home, db, localStore, options });
}
