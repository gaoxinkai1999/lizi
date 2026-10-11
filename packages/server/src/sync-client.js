import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { getSetting, setSetting, transaction } from "./database.js";
import { httpError } from "./directories.js";
import { CENTER_URL, APP_VERSION, INSTRUMENT_TYPES, normalizeInstrumentId } from "../../core/src/deployment.js";
import { initializeOutbox, readSyncConfig, validateBackfillRange, MAX_EVENT_BYTES, MAX_BATCH_BYTES } from "./sync-outbox.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const AUTH_STATUS = new Set([401, 403]);
const PERMANENT = new Set([400, 401, 403, 404, 405, 409, 413, 415, 422]);
// Enrollment keeps a bounded, visible retry for conflicts/limits/rate caps; only a rejected
// credential stops it. An admin can free a duplicate short ID, so 409 must remain retryable.
const ENROLL_PERMANENT = new Set([400, 404, 405, 415, 422]);
const REGISTRATION_STATES = new Set(["unconfigured", "pending", "approved", "revoked"]);
const INSTRUMENT_TYPE_IDS = new Set(INSTRUMENT_TYPES.map((type) => type.id));
// 3.0 forms no longer exist: server URL, token, enable toggle and physical device ID are never user input.
const LEGACY_INPUT_KEYS = ["serverUrl", "token", "enabled", "deviceId"];
const CREDENTIALS_ERROR = "上传凭据缺失或与当前中心不匹配，请在设置中重新保存";
const LEGACY_ENDPOINT_ERROR = "旧上传服务器仍有未上传报告，已停止向新中心自动迁移；请先处理旧服务器的积压报告（本版本不支持在设置中解除）";
const MAX_DELAY = 300000;
const ENROLL_POLL_MS = 30000;

export function normalizeServerUrl(value, allowLoopbackHttp = false) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw httpError(400, "中心地址无效"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && loopback))
    throw httpError(400, "中心地址必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value))
    throw httpError(400, "中心地址不能包含账号、查询参数或片段");
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

function errorMessage(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message ?? String(error);
}

class SyncClient extends EventEmitter {
  constructor({ home, db, localStore, options }) {
    super();
    this.db = db;
    this.localStore = localStore;
    this.options = options;
    this.credentialsPath = path.join(home, "sync-credentials.json");
    initializeOutbox(db);
    // Fixed mainland center; only test harnesses may inject an alternate loopback URL.
    this.centerUrl = normalizeServerUrl(options.centerUrl ?? CENTER_URL, options.allowLoopbackHttp);
    const stored = readSyncConfig(db);
    const deviceId = stored?.deviceId ?? options.deviceId ?? randomUUID();
    if (!UUID.test(deviceId) || (options.deviceId && options.deviceId !== deviceId))
      throw httpError(409, "上传设备标识必须与本地设备标识一致");
    const identityLocked = getSetting(db, "syncIdentityLocked") === "true";
    this.config = this.migrateConfig(stored, deviceId, identityLocked);
    this.legacyEndpoint = this.detectLegacyEndpoint(stored) || getSetting(db, "syncLegacyEndpoint", "");
    if (this.legacyEndpoint === CENTER_URL) this.legacyEndpoint = "";
    // The block marker is durable until the old backlog is truly drained; rewriting the internal
    // config (which drops the old serverUrl) must not make a later restart forget the refusal.
    this.legacyBlocked = Boolean(this.legacyEndpoint) &&
      Boolean(db.prepare("SELECT 1 FROM sync_outbox LIMIT 1").get());
    setSetting(db, "syncLegacyEndpoint", this.legacyBlocked ? this.legacyEndpoint : "");
    setSetting(db, "syncConfig", JSON.stringify(this.config));
    this.credentials = this.loadCredentials();
    this.credentialError = null;
    // Adopting the fixed center is safe only when the old queue is already drained; re-baseline then.
    if (this.legacyEndpoint && !this.legacyBlocked) db.exec("UPDATE sync_versions SET content_hash=''");
    this.state = this.loadState();
    this.migrateCredentials();
    if (this.legacyBlocked) {
      this.state.paused = true;
      this.state.lastError = LEGACY_ENDPOINT_ERROR;
    } else if (this.config.configured && !this.secret()) {
      this.state.paused = true;
      this.state.lastError = this.credentialError ?? CREDENTIALS_ERROR;
    }
    this.connected = false;
    this.requests = new Set();
    this.generation = 0;
    this.closed = false;
    this.started = false;
    this.flight = null;
    this.enrollFlight = null;
    this.heartbeatFlight = null;
    this.queueMetrics = { pending: null, oldestPendingAt: null, backfillPendingDays: null };
    this.onLocalStatus = () => this.emitStatus();
    this.onRevision = () => { this.emitStatus(); this.kick(); };
  }

  migrateConfig(stored, deviceId, identityLocked) {
    const config = { deviceId, instrumentId: "", instrumentType: "strength", configured: false };
    if (!stored || typeof stored !== "object") return config;
    config.instrumentType = INSTRUMENT_TYPE_IDS.has(stored.instrumentType) ? stored.instrumentType : "strength";
    let instrumentId = typeof stored.instrumentId === "string" ? stored.instrumentId : "";
    if (identityLocked) {
      // A locked identity is never rewritten, even when a legacy value is not a short ID.
    } else {
      try { instrumentId = normalizeInstrumentId(instrumentId); } catch { instrumentId = ""; }
    }
    config.instrumentId = instrumentId;
    config.configured = Boolean(stored.configured) && Boolean(instrumentId) &&
      INSTRUMENT_TYPE_IDS.has(config.instrumentType);
    return config;
  }

  detectLegacyEndpoint(stored) {
    if (!stored || typeof stored !== "object" || typeof stored.serverUrl !== "string" || !stored.serverUrl) return "";
    let normalized;
    try { normalized = normalizeServerUrl(stored.serverUrl, this.options.allowLoopbackHttp); } catch { return stored.serverUrl; }
    return normalized && normalized !== CENTER_URL ? normalized : "";
  }

  loadCredentials() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
      fs.chmodSync(this.credentialsPath, 0o600);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // A missing/unreadable secret must stop uploading, not local acquisition.
      return null;
    }
  }

  loadState() {
    let stored = null;
    try { stored = JSON.parse(getSetting(this.db, "syncState", "null")); } catch { stored = null; }
    const state = {
      lastSuccessAt: null, nextAttemptAt: null, lastError: null, paused: false, attempts: 0,
      registrationState: this.config.configured ? "pending" : "unconfigured", enrollNextAt: null, enrollAttempts: 0,
    };
    if (stored && typeof stored === "object") Object.assign(state, stored);
    if (!REGISTRATION_STATES.has(state.registrationState))
      state.registrationState = this.config.configured ? "pending" : "unconfigured";
    if (!this.config.configured) state.registrationState = "unconfigured";
    return state;
  }

  // Migration only rewrites an existing 3.0 credential file, and only when the file has no
  // centerUrl of its own: a mismatched current-schema file must stay visible until re-saved.
  migrateCredentials() {
    if (this.legacyBlocked || !this.config.configured || this.secret()) return;
    const credentials = this.credentials;
    if (!credentials || credentials.deviceId !== this.config.deviceId || "centerUrl" in credentials) return;
    const token = typeof credentials.token === "string" && SECRET.test(credentials.token) ? credentials.token : "";
    const sameTarget = !this.legacyEndpoint || this.legacyEndpoint === CENTER_URL;
    let candidate = null;
    // The center still holds the 3.0 token hash, so a same-center token must be reused verbatim.
    // Only a drained, different former target may receive a freshly generated secret.
    if (token && sameTarget) candidate = { centerUrl: this.centerUrl, deviceId: this.config.deviceId, secret: token };
    else if (!sameTarget) candidate = this.issueCredentials();
    if (!candidate) return;
    try { this.writeCredentials(candidate); }
    catch { this.credentialError = "无法安全保存上传凭据，请检查磁盘空间和权限"; }
  }

  // Explicit re-save may repair any credential: reuse a valid secret or 3.0 token, else issue one.
  adoptableCredentials() {
    const credentials = this.credentials;
    if (credentials && credentials.deviceId === this.config.deviceId) {
      if (SECRET.test(credentials.secret ?? ""))
        return { centerUrl: this.centerUrl, deviceId: this.config.deviceId, secret: credentials.secret };
      const token = typeof credentials.token === "string" && SECRET.test(credentials.token) ? credentials.token : "";
      if (token && (!this.legacyEndpoint || this.legacyEndpoint === CENTER_URL))
        return { centerUrl: this.centerUrl, deviceId: this.config.deviceId, secret: token };
    }
    return this.issueCredentials();
  }

  issueCredentials() {
    return { centerUrl: this.centerUrl, deviceId: this.config.deviceId, secret: randomBytes(32).toString("base64url") };
  }

  secret() {
    const credentials = this.credentials;
    return credentials && credentials.deviceId === this.config.deviceId &&
      credentials.centerUrl === this.centerUrl && SECRET.test(credentials.secret ?? "")
      ? credentials.secret : "";
  }

  getSettings() {
    return {
      instrumentId: this.config.instrumentId,
      instrumentType: this.config.instrumentType,
      configured: this.config.configured,
      identityLocked: getSetting(this.db, "syncIdentityLocked") === "true",
      centerUrl: this.centerUrl,
    };
  }

  acquisitionError() {
    const failure = errorMessage(this.localStore.failure);
    if (failure) return failure;
    const first = this.localStore.status?.().errors?.[0];
    const reported = errorMessage(first);
    if (reported) return reported;
    // Configured but no source directory: the center must not see a healthy client that can never collect.
    const root = this.localStore.root;
    if (this.config.configured && (root === "" || root === null || root === undefined))
      return "尚未设置报告目录";
    return null;
  }

  getStatus() {
    let queueMetricsStale = false;
    try {
      this.queueMetrics = this.db.prepare(`SELECT COUNT(*) AS pending,MIN(created_at) AS oldestPendingAt,
        (SELECT COUNT(*) FROM sync_backfill) AS backfillPendingDays FROM sync_outbox`).get();
    } catch {
      queueMetricsStale = true;
      this.connected = false;
    }
    const acquisitionError = this.acquisitionError();
    const missingSecret = this.config.configured && !this.secret() && !this.legacyBlocked;
    let lastError = this.state.lastError;
    let paused = this.state.paused;
    if (this.legacyBlocked) { lastError = LEGACY_ENDPOINT_ERROR; paused = true; }
    else if (missingSecret) { lastError = this.credentialError ?? CREDENTIALS_ERROR; paused = true; }
    if (queueMetricsStale) {
      lastError = "上传队列读取失败，请检查磁盘空间和权限；显示最后已知队列状态";
      paused = true;
    }
    return {
      configured: this.config.configured,
      connected: this.connected,
      registrationState: this.config.configured ? this.state.registrationState : "unconfigured",
      clientVersion: APP_VERSION,
      pending: this.queueMetrics.pending,
      oldestPendingAt: this.queueMetrics.oldestPendingAt,
      backfillPendingDays: this.queueMetrics.backfillPendingDays,
      queueMetricsStale,
      lastSuccessAt: this.state.lastSuccessAt,
      nextAttemptAt: this.state.nextAttemptAt,
      lastError,
      acquisitionError,
      paused,
      attempts: this.state.attempts,
    };
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
    // A legacy endpoint with an undrained queue must never be retargeted onto the fixed center,
    // not even by an explicit settings save. Resolution of that backlog is a separate, explicit step.
    if (this.legacyBlocked) throw httpError(409, LEGACY_ENDPOINT_ERROR);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "上传设置无效");
    for (const key of LEGACY_INPUT_KEYS)
      if (input[key] !== undefined)
        throw httpError(400, "上传服务器、设备令牌与启用开关由系统统一管理，不再支持手工设置");
    let instrumentId = this.config.instrumentId;
    if (input.instrumentId !== undefined) {
      if (typeof input.instrumentId !== "string") throw httpError(400, "仪器编号无效");
      try { instrumentId = normalizeInstrumentId(input.instrumentId); }
      catch (error) { throw httpError(400, error.message); }
    }
    if (!instrumentId) throw httpError(400, "请输入仪器编号");
    let instrumentType = this.config.instrumentType;
    if (input.instrumentType !== undefined) {
      if (typeof input.instrumentType !== "string" || !INSTRUMENT_TYPE_IDS.has(input.instrumentType))
        throw httpError(400, "目前仅支持强力仪 strength");
      instrumentType = input.instrumentType;
    }
    const identityLocked = getSetting(this.db, "syncIdentityLocked") === "true";
    if (identityLocked && instrumentId !== this.config.instrumentId)
      throw httpError(409, "已有上传记录，仪器编号不可更改");
    const identityChanged = instrumentId !== this.config.instrumentId || instrumentType !== this.config.instrumentType;
    const next = { ...this.config, instrumentId, instrumentType, configured: true };
    const fresh = this.secret() ? null : this.adoptableCredentials();
    const previousCredentials = this.credentials;
    let wroteCredentials = false;
    try {
      transaction(this.db, () => {
        if (fresh) { this.writeCredentials(fresh); this.credentials = fresh; wroteCredentials = true; }
        setSetting(this.db, "syncConfig", JSON.stringify(next));
        if (identityChanged) this.db.exec("UPDATE sync_versions SET content_hash=''");
        this.state = { ...this.state, nextAttemptAt: null, lastError: null, paused: false, attempts: 0,
          registrationState: "pending", enrollNextAt: null, enrollAttempts: 0 };
        setSetting(this.db, "syncState", JSON.stringify(this.state));
      });
    } catch (error) {
      if (wroteCredentials) {
        try { this.writeCredentials(previousCredentials); this.credentials = previousCredentials; }
        catch { /* Credential rollback failure stays visible through the thrown error. */ }
      }
      throw error;
    }
    this.credentialError = null;
    this.generation += 1;
    for (const request of this.requests) request.destroy(new Error("configuration changed"));
    this.config = next;
    this.connected = false;
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
    Object.assign(this.state, { nextAttemptAt: null, lastError: null, paused: false, attempts: 0,
      enrollNextAt: null, enrollAttempts: 0 });
    if (this.config.configured && this.state.registrationState === "unconfigured")
      this.state.registrationState = "pending";
    this.saveState();
    this.kick();
    this.heartbeat();
    return this.getStatus();
  }

  async backfill(input) {
    if (this.closed) throw httpError(503, "上传服务已关闭");
    if (!this.config.configured) throw httpError(400, "请先保存仪器编号与类型");
    const { from, to } = validateBackfillRange(input);
    const scheduled = await this.localStore.syncBackfill({ from, to });
    this.emitStatus();
    return { ...scheduled, status: this.getStatus() };
  }

  canSend() {
    return this.started && !this.closed && this.config.configured &&
      this.state.registrationState === "approved" && Boolean(this.secret());
  }

  post(route, body) {
    const payload = JSON.stringify(body);
    const url = new URL(`${this.centerUrl}/api/ingest/${route}`);
    const secret = this.secret();
    return new Promise((resolve, reject) => {
      if (!secret) { reject(httpError(401, "上传凭据缺失")); return; }
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, { method: "POST", rejectUnauthorized: true,
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
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

  failure(message, permanent = false, minimumDelay = 0) {
    this.connected = false;
    this.state.lastError = message;
    this.state.paused = permanent;
    this.state.attempts = Math.min(20, this.state.attempts + 1);
    const delay = Math.min(MAX_DELAY, Math.max(minimumDelay,
      Math.min(MAX_DELAY, 2000 * 2 ** (this.state.attempts - 1)) * (1 + Math.random() * 0.25)));
    this.state.nextAttemptAt = permanent ? null : new Date(Date.now() + delay).toISOString();
    this.saveState();
  }

  // A rejected credential is not a permanent local state: re-confirm enrollment before deciding.
  registrationFailed(message) {
    this.connected = false;
    if (this.state.registrationState === "approved") this.state.registrationState = "pending";
    this.state.lastError = message;
    this.state.paused = false;
    this.state.enrollNextAt = null;
    this.saveState();
    this.kick();
  }

  permanentEnrollment(message) {
    this.state.paused = true;
    this.state.lastError = message;
    this.state.enrollNextAt = null;
    this.saveState();
  }

  scheduleEnrollment(message, minimumDelay = 0) {
    this.connected = false;
    this.state.lastError = message;
    this.state.enrollAttempts = Math.min(20, (this.state.enrollAttempts ?? 0) + 1);
    const backoff = Math.min(MAX_DELAY, 2000 * 2 ** (this.state.enrollAttempts - 1));
    const delay = Math.min(MAX_DELAY, Math.max(minimumDelay, backoff * (1 + Math.random() * 0.25)));
    this.state.enrollNextAt = new Date(Date.now() + delay).toISOString();
    this.saveState();
  }

  // Center-side conflicts/limits/rate caps keep the unapproved 30s cadence instead of a long backoff.
  scheduleEnrollmentRetry(message, minimumDelay = 0) {
    this.connected = false;
    this.state.lastError = message;
    this.state.enrollAttempts = 0;
    const delay = Math.min(MAX_DELAY, Math.max(minimumDelay, ENROLL_POLL_MS));
    this.state.enrollNextAt = new Date(Date.now() + delay).toISOString();
    this.saveState();
  }

  enrollDue() {
    return !this.state.enrollNextAt || Date.parse(this.state.enrollNextAt) <= Date.now();
  }

  enrollIfDue() {
    if (this.closed || this.enrollFlight || this.legacyBlocked || !this.config.configured) return;
    if (this.state.registrationState === "approved" || this.state.paused) return;
    if (!this.secret() || !this.enrollDue()) return;
    this.enroll();
  }

  enroll() {
    const generation = this.generation;
    const body = { protocolVersion: 1, deviceId: this.config.deviceId, instrumentId: this.config.instrumentId,
      instrumentType: this.config.instrumentType, clientVersion: APP_VERSION };
    this.enrollFlight = this.post("enroll", body).then((response) => {
      if (this.closed || generation !== this.generation) return;
      this.handleEnrollment(response);
    }).catch(() => {
      if (this.closed || generation !== this.generation) return;
      this.scheduleEnrollment("网络不可用或登记请求超时，报告已保留，稍后自动重试");
    }).finally(() => { this.enrollFlight = null; });
  }

  handleEnrollment({ status, body, retryAfter: after }) {
    const registrationState = body?.registrationState;
    if ((status === 200 || status === 202) && body?.protocolVersion === 1 &&
        body.deviceId === this.config.deviceId && REGISTRATION_STATES.has(registrationState)) {
      this.state.enrollAttempts = 0;
      this.state.registrationState = registrationState;
      this.state.lastError = null;
      if (registrationState === "approved") {
        Object.assign(this.state, { paused: false, nextAttemptAt: null, enrollNextAt: null });
      } else {
        // Pending awaits admin approval; revoked keeps its queue and slow-polls for re-enable.
        this.state.enrollNextAt = new Date(Date.now() + ENROLL_POLL_MS).toISOString();
      }
      this.saveState();
      if (registrationState === "approved") { this.kick(); this.heartbeat(); }
      return;
    }
    const detail = typeof body?.error === "string" ? body.error : "";
    if (status === 401) {
      this.permanentEnrollment(detail || "设备凭据被中心拒绝，可能已被其他设备占用；请联系管理员重新登记");
      return;
    }
    if (ENROLL_PERMANENT.has(status)) {
      this.permanentEnrollment(`中心拒绝登记（HTTP ${status}）${detail ? `：${detail}` : "，请检查中心版本与登记参数"}`);
      return;
    }
    // Duplicate short ID, size limits, rate caps and server errors stay visible but retryable.
    this.scheduleEnrollmentRetry(detail || (status === 409
      ? "该仪器编号已被其他设备占用，或本机已登记且不支持直接更换编号/类型；请联系管理员处理"
      : `中心登记暂不可用（HTTP ${status}），报告已保留，稍后自动重试`), after);
  }

  kick() {
    if (!this.started || this.closed || this.legacyBlocked || !this.config.configured) return;
    if (this.state.registrationState !== "approved") { this.enrollIfDue(); return; }
    if (this.state.paused || this.flight) return;
    if (Date.parse(this.state.nextAttemptAt) > Date.now()) return;
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
      if (AUTH_STATUS.has(response.status)) {
        this.registrationFailed(response.body?.error || "设备尚未获批准或登记已失效，正在重新确认登记状态");
        return;
      }
      this.failure(`服务器拒绝上传（HTTP ${response.status}），报告已保留`,
        PERMANENT.has(response.status) || (response.status >= 300 && response.status < 400), response.retryAfter);
      return;
    }
    const acknowledged = exactAcknowledgements(response.body, this.config.deviceId, events);
    if (!acknowledged.length) { this.failure("服务器确认无效，报告已保留，将以相同事件标识重试"); return; }
    const complete = acknowledged.length === events.length;
    const nextState = { ...this.state, lastSuccessAt: new Date().toISOString(), attempts: 0,
      nextAttemptAt: null, registrationState: "approved",
      lastError: this.state.paused ? this.state.lastError : null };
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
    if (!this.canSend() || this.heartbeatFlight || this.state.paused) return;
    const generation = this.generation;
    const status = this.getStatus();
    if (status.queueMetricsStale) return;
    this.heartbeatFlight = this.post("heartbeat", { protocolVersion: 1, deviceId: this.config.deviceId,
      pending: status.pending, oldestPendingAt: status.oldestPendingAt,
      lastError: status.lastError?.slice(0, 256) ?? null,
      acquisitionError: status.acquisitionError?.slice(0, 256) ?? null,
      clientVersion: APP_VERSION })
      .then((response) => {
        if (this.closed || generation !== this.generation) return;
        if (AUTH_STATUS.has(response.status)) {
          this.registrationFailed(response.body?.error || "设备尚未获批准或登记已失效，正在重新确认登记状态");
          return;
        }
        if (response.status >= 200 && response.status < 300) {
          const registrationState = response.body?.registrationState;
          if (REGISTRATION_STATES.has(registrationState) && registrationState !== this.state.registrationState) {
            this.state.registrationState = registrationState;
            this.saveState();
            if (registrationState === "approved") { this.kick(); return; }
          }
          this.connected = true;
          this.emitStatus();
        }
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
    await Promise.allSettled([this.flight, this.heartbeatFlight, this.enrollFlight]);
  }
}

export async function createSyncClient({ home, db, localStore, options = {} }) {
  return new SyncClient({ home, db, localStore, options });
}
