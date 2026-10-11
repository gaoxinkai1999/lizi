import express from "express";
import { transaction } from "./database.js";
import { httpError } from "./directories.js";
import { CloudStore, initializeCloud, registrationStateOf } from "./cloud-store.js";
import { bearerSecret, hash, object, text, validateEnroll, validateEnvelope, validateEvent, validateHeartbeat } from "./cloud-protocol.js";

const ack = (event) => ({ eventId: event.eventId, reportId: event.reportId, sequence: event.sequence, contentHash: event.contentHash });
const ENROLL_BODY_LIMIT = 8 * 1024;
const UPLOAD_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 256;
const RATE_WINDOW_MS = 60000;
const DEFAULT_DEVICE_RATE = 120;
const ENROLL_RATE_WINDOW_MS = 60000;
const DEFAULT_ENROLL_PER_IP = 60;
const DEFAULT_ENROLL_GLOBAL = 1200;
const ENROLL_MAX_KEYS = 2048;
const RATE_MAP_MAX = 4096;

// Bounded sliding-window limiter: the key map is capped and entries expire with the window.
function createRateLimiter({ windowMs = ENROLL_RATE_WINDOW_MS, perKey = DEFAULT_ENROLL_PER_IP, global = DEFAULT_ENROLL_GLOBAL, maxKeys = ENROLL_MAX_KEYS } = {}) {
  const keys = new Map();
  let globalSince = Date.now();
  let globalCount = 0;
  const prune = (now) => {
    if (keys.size <= maxKeys) return;
    for (const [key, entry] of keys)
      if (now - entry.since >= windowMs) keys.delete(key);
  };
  return {
    allow(key) {
      const now = Date.now();
      if (now - globalSince >= windowMs) {
        globalSince = now;
        globalCount = 0;
      }
      if (++globalCount > global) return false;
      let entry = keys.get(key);
      if (!entry || now - entry.since >= windowMs) {
        prune(now);
        if (!keys.has(key) && keys.size >= maxKeys) return false;
        entry = { since: now, count: 0 };
        keys.set(key, entry);
      }
      return ++entry.count <= perKey;
    },
    delete(key) { keys.delete(key); },
    clear() { keys.clear(); },
  };
}

export async function createCloud({ db, options = {} }) {
  initializeCloud(db);
  const store = new CloudStore(db, options);
  const machineRouter = express.Router();
  const adminRouter = express.Router();
  const rates = new Map();
  const enrollOptions = options.enroll ?? {};
  const maxPending = enrollOptions.maxPending ?? DEFAULT_MAX_PENDING;
  const enrollRates = createRateLimiter({
    windowMs: enrollOptions.windowMs,
    perKey: enrollOptions.perIp,
    global: enrollOptions.global,
    maxKeys: enrollOptions.maxKeys,
  });
  const findToken = db.prepare("SELECT * FROM cloud_devices WHERE token_hash=?");
  const findDevice = db.prepare("SELECT * FROM cloud_devices WHERE id=?");
  const findSecret = db.prepare("SELECT id FROM cloud_devices WHERE token_hash=?");
  const findInstrument = db.prepare("SELECT id FROM cloud_devices WHERE instrument_id=? AND instrument_type=? AND id<>?");
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM cloud_devices WHERE registration_state='pending' AND revoked=0");
  const insertDevice = db.prepare(`INSERT INTO cloud_devices
    (id,name,location,instrument_id,instrument_type,token_hash,registration_state,revoked,client_version)
    VALUES(?,?,NULL,?,?,?,'pending',0,?)`);
  const updateClientVersion = db.prepare("UPDATE cloud_devices SET client_version=? WHERE id=?");
  const updateInstrument = db.prepare("UPDATE cloud_devices SET instrument_id=?,instrument_type=?,name=CASE WHEN name=instrument_id THEN ? ELSE name END,client_version=? WHERE id=?");
  const approveDevice = db.prepare("UPDATE cloud_devices SET registration_state='approved',revoked=0 WHERE id=?");
  const revokeDevice = db.prepare("UPDATE cloud_devices SET registration_state='revoked',revoked=1 WHERE id=?");
  const updateMetadata = db.prepare("UPDATE cloud_devices SET name=?,location=? WHERE id=?");
  const countDeviceReports = db.prepare("SELECT COUNT(*) AS n FROM cloud_versions WHERE device_id=?");
  const deleteDevice = db.prepare("DELETE FROM cloud_devices WHERE id=?");
  const updateHeartbeat = db.prepare("UPDATE cloud_devices SET last_seen_at=?,pending=?,oldest_pending_at=?,last_error=?,acquisition_error=?,client_version=COALESCE(?,client_version) WHERE id=?");
  const currentRevision = () => db.prepare("SELECT revision FROM cloud_state WHERE id=1").get().revision;

  function authorize(req) {
    store.assertOpen();
    const device = findToken.get(hash(bearerSecret(req)));
    if (!device) throw httpError(401, "设备密钥无效");
    const registration = registrationStateOf(device);
    if (registration === "revoked") throw httpError(401, "设备已停用，等待管理员重新启用");
    if (registration === "pending") throw httpError(403, "设备等待管理员审批，批准后自动开始上传");
    return device;
  }
  function requireDevice(id) {
    const device = findDevice.get(id);
    if (!device) throw httpError(404, "设备不存在");
    return device;
  }
  function enrollResponse(deviceId, registrationState) {
    return { protocolVersion: 1, deviceId, registrationState };
  }

  // Enrollment is unauthenticated by session but REQUIRES a client-generated bearer secret.
  // It is registered before authorize/global JSON so a small bounded body is parsed first.
  machineRouter.post("/enroll", express.json({ limit: ENROLL_BODY_LIMIT, strict: true, inflate: false }), (req, res, next) => {
    try {
      const secret = bearerSecret(req);
      const key = req.ip ?? "unknown";
      if (!enrollRates.allow(key)) {
        res.setHeader("Retry-After", "60");
        throw httpError(429, "注册请求过于频繁，请稍后重试");
      }
      const input = validateEnroll(req.body);
      const existing = findDevice.get(input.deviceId);
      if (existing) {
        if (existing.token_hash !== hash(secret)) throw httpError(401, "该设备 ID 已使用其他密钥注册");
        const registrationState = registrationStateOf(existing);
        if (existing.instrument_id !== input.instrumentId || existing.instrument_type !== input.instrumentType) {
          // Identity is only locked once the device has produced a report version.
          if (countDeviceReports.get(existing.id).n > 0) throw httpError(409, "设备已生成报告，仪器编号不可更改；请先停用设备并重新配置");
          if (findInstrument.get(input.instrumentId, input.instrumentType, existing.id)) throw httpError(409, "该仪器编号已被其他设备使用");
          transaction(db, () => updateInstrument.run(input.instrumentId, input.instrumentType, input.instrumentId, input.clientVersion, existing.id));
          store.devicesChanged();
        } else if ((existing.client_version ?? null) !== input.clientVersion) {
          transaction(db, () => updateClientVersion.run(input.clientVersion, existing.id));
          store.devicesChanged();
        }
        res.status(registrationState === "pending" ? 202 : 200).json(enrollResponse(existing.id, registrationState));
        return;
      }
      if (findSecret.get(hash(secret))) throw httpError(401, "该密钥已绑定其他设备");
      if (countPending.get().n >= maxPending) throw httpError(429, "待审批设备过多，请管理员处理后重试");
      if (findInstrument.get(input.instrumentId, input.instrumentType, input.deviceId)) throw httpError(409, "该仪器编号已被其他设备使用");
      transaction(db, () => insertDevice.run(input.deviceId, input.instrumentId, input.instrumentId, input.instrumentType, hash(secret), input.clientVersion));
      res.status(202).json(enrollResponse(input.deviceId, "pending"));
      store.changed(currentRevision());
      store.devicesChanged();
    } catch (error) { next(error); }
  });

  machineRouter.use((req, res, next) => {
    try {
      const device = authorize(req);
      const now = Date.now();
      // Buckets exist only for registered authenticated devices, not arbitrary IPs/tokens.
      if (rates.size > RATE_MAP_MAX)
        for (const [id, entry] of rates)
          if (now - entry.since >= RATE_WINDOW_MS) rates.delete(id);
      let rate = rates.get(device.id);
      if (!rate || now - rate.since >= RATE_WINDOW_MS) {
        rate = { since: now, count: 0 };
        rates.set(device.id, rate);
      }
      if (++rate.count > DEFAULT_DEVICE_RATE) {
        res.setHeader("Retry-After", "60");
        throw httpError(429, "设备上传请求过于频繁，请稍后重试");
      }
      next();
    } catch (error) { next(error); }
  });
  machineRouter.use(express.json({ limit: UPLOAD_BODY_LIMIT, strict: true, inflate: false }));

  const insertVersion = db.prepare(`INSERT INTO cloud_versions
    (device_id,report_id,sequence,id,content_hash,version_hash,instrument_id,instrument_type,
     schema_version,parser_version,occurred_at,historical,received_at,timestamp,aggregate,detail_count,json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const findVersion = db.prepare("SELECT version_hash FROM cloud_versions WHERE device_id=? AND report_id=? AND sequence=?");
  const findReceipt = db.prepare("SELECT version_hash,report_id,sequence,content_hash FROM cloud_receipts WHERE device_id=? AND event_id=?");
  const insertReceipt = db.prepare("INSERT INTO cloud_receipts(device_id,event_id,report_id,sequence,content_hash,version_hash,received_at) VALUES(?,?,?,?,?,?,?)");
  const updateCurrent = db.prepare(`INSERT INTO cloud_current(id,device_id,report_id,sequence) VALUES(?,?,?,?)
    ON CONFLICT(device_id,report_id) DO UPDATE SET sequence=excluded.sequence WHERE excluded.sequence>cloud_current.sequence`);

  machineRouter.post("/reports", (req, res, next) => {
    try {
      const device = authorize(req);
      validateEnvelope(req.body, device);
      if (!Array.isArray(req.body.events) || !req.body.events.length) throw httpError(422, "上传事件列表不能为空");
      if (req.body.events.length > 32) throw httpError(413, "每批最多上传 32 个事件");
      const events = req.body.events.map((event) => validateEvent(event, device));
      const now = new Date().toISOString();
      let changed = false;
      transaction(db, () => {
        // Authentication is rechecked after parsing, immediately before the atomic write.
        authorize(req);
        for (const item of events) {
          const { event, json, versionHash, id } = item;
          const receipt = findReceipt.get(device.id, event.eventId);
          if (receipt) {
            if (receipt.version_hash !== versionHash || receipt.report_id !== event.reportId || receipt.sequence !== event.sequence || receipt.content_hash !== event.contentHash) throw httpError(409, "事件 ID 已用于不同上传内容");
            continue;
          }
          const version = findVersion.get(device.id, event.reportId, event.sequence);
          if (version && version.version_hash !== versionHash) throw httpError(409, "报告版本号已用于不同上传内容");
          if (!version) insertVersion.run(device.id, event.reportId, event.sequence, id, event.contentHash, versionHash, event.instrumentId, event.instrumentType, event.schemaVersion, event.parserVersion, event.occurredAt, Number(event.historical), now, `${event.report.date}T${event.report.time}`, Number(event.report.isAggregate), event.report.testResults.length + event.report.segmentInfoList.length, json);
          insertReceipt.run(device.id, event.eventId, event.reportId, event.sequence, event.contentHash, versionHash, now);
          if (updateCurrent.run(id, device.id, event.reportId, event.sequence).changes > 0) changed = true;
        }
        // An upload is proof of life: last seen advances here as well as on heartbeat.
        db.prepare("UPDATE cloud_devices SET last_seen_at=?,last_received_at=? WHERE id=?").run(now, now, device.id);
        if (changed) db.exec("UPDATE cloud_state SET revision=revision+1 WHERE id=1");
      });
      // No acknowledgement exists before COMMIT. Failure or connection loss safely replays receipts.
      res.json({ protocolVersion: 1, deviceId: device.id, acknowledgements: events.map(({ event }) => ack(event)) });
      store.changed(currentRevision());
    } catch (error) { next(error); }
  });

  machineRouter.post("/heartbeat", (req, res, next) => {
    try {
      const device = authorize(req);
      const beat = validateHeartbeat(req.body, device);
      transaction(db, () => {
        authorize(req);
        updateHeartbeat.run(new Date().toISOString(), beat.pending, beat.oldestPendingAt, beat.lastError, beat.acquisitionError, beat.clientVersion, device.id);
      });
      res.json({ protocolVersion: 1, deviceId: device.id, registrationState: "approved" });
      store.changed(currentRevision());
    } catch (error) { next(error); }
  });

  // Browser authentication, admin authorization and same-origin checks are required at the mount.
  adminRouter.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try { store.assertOpen(); next(); } catch (error) { next(error); }
  });
  adminRouter.get("/", (req, res) => res.json({ devices: store.devices(), summary: store.summary() }));
  adminRouter.post("/:id/approve", (req, res, next) => {
    try {
      if (req.body !== undefined && (!object(req.body) || Object.keys(req.body).length)) throw httpError(422, "审批请求不接受参数");
      const device = requireDevice(req.params.id);
      // Approving a new or revoked device KEEPS the stored credential so the client recovers automatically.
      if (registrationStateOf(device) !== "approved") transaction(db, () => approveDevice.run(device.id));
      rates.delete(device.id);
      res.json({ device: store.device(device.id) });
      store.changed(currentRevision());
      store.devicesChanged();
    } catch (error) { next(error); }
  });
  adminRouter.delete("/:id", (req, res, next) => {
    try {
      if (req.body !== undefined && (!object(req.body) || Object.keys(req.body).length)) throw httpError(422, "停用请求不接受参数");
      const device = requireDevice(req.params.id);
      if (registrationStateOf(device) === "pending" && countDeviceReports.get(device.id).n === 0) {
        // A pending client can never upload, so rejecting frees the short ID and credential.
        transaction(db, () => deleteDevice.run(device.id));
        rates.delete(device.id);
        res.json({ device: null, rejected: true });
      } else {
        // Revocation only withdraws upload permission; every stored report is kept.
        if (registrationStateOf(device) !== "revoked") transaction(db, () => revokeDevice.run(device.id));
        rates.delete(device.id);
        res.json({ device: store.device(device.id) });
      }
      store.changed(currentRevision());
      store.devicesChanged();
    } catch (error) { next(error); }
  });
  adminRouter.patch("/:id", (req, res, next) => {
    try {
      const body = req.body;
      if (!object(body)) throw httpError(422, "请求体必须为 JSON 对象");
      const fields = Object.keys(body);
      if (!fields.length || fields.some((key) => key !== "name" && key !== "location")) throw httpError(422, "仅支持修改设备名称与位置");
      const device = requireDevice(req.params.id);
      let name = device.name;
      let location = device.location ?? null;
      if ("name" in body) {
        if (!text(body.name, 128)) throw httpError(422, "设备名称需为 1–128 个字符");
        name = body.name;
      }
      if ("location" in body) {
        const value = body.location;
        if (value === null || value === "") location = null;
        else if (!text(value, 128)) throw httpError(422, "设备位置需为 1–128 个字符");
        else location = value;
      }
      transaction(db, () => updateMetadata.run(name, location, device.id));
      res.json({ device: store.device(device.id) });
      store.changed(currentRevision());
      store.devicesChanged();
    } catch (error) { next(error); }
  });
  function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    const sqliteCode = error.errcode & 255;
    const busy = sqliteCode === 5 || sqliteCode === 6 || /SQLITE_BUSY|SQLITE_LOCKED/.test(error.code ?? "");
    let status = error.status ?? 500;
    if (busy) status = 503;
    else if (error.type === "entity.too.large") status = 413;
    else if (error.type === "entity.parse.failed") status = 422;
    if (busy) res.setHeader("Retry-After", "2");
    let message = error.message;
    if (status >= 500) message = "中心存储暂不可用，请稍后重试";
    else if (error.type) message = "上传请求格式或大小无效";
    res.status(status).json({ error: message });
  }
  machineRouter.use(errorHandler);
  adminRouter.use(errorHandler);
  return { store, machineRouter, adminRouter, status: () => store.status(), async close() { rates.clear(); enrollRates.clear(); await store.close(); } };
}
