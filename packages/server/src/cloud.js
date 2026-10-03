import { randomBytes } from "node:crypto";
import express from "express";
import { transaction } from "./database.js";
import { httpError } from "./directories.js";
import { CloudStore, initializeCloud, publicDevice } from "./cloud-store.js";
import { hash, iso, text, validateDevice, validateEnvelope, validateEvent } from "./cloud-protocol.js";

const token = () => randomBytes(32).toString("base64url");
const ack = (event) => ({ eventId: event.eventId, reportId: event.reportId, sequence: event.sequence, contentHash: event.contentHash });

export async function createCloud({ db, options = {} }) {
  initializeCloud(db);
  const store = new CloudStore(db, options);
  const machineRouter = express.Router();
  const adminRouter = express.Router();
  const rates = new Map();
  const findToken = db.prepare("SELECT * FROM cloud_devices WHERE token_hash=? AND revoked=0");
  const findDevice = db.prepare("SELECT * FROM cloud_devices WHERE id=?");
  const currentRevision = () => db.prepare("SELECT revision FROM cloud_state WHERE id=1").get().revision;
  function authorize(req) {
    store.assertOpen();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "");
    const device = match && findToken.get(hash(match[1]));
    if (!device) throw httpError(401, "设备令牌无效或已撤销");
    return device;
  }
  function requireDevice(id) {
    const device = findDevice.get(id);
    if (!device) throw httpError(404, "设备不存在");
    return device;
  }
  machineRouter.use((req, res, next) => {
    try {
      const device = authorize(req);
      const now = Date.now();
      // Buckets exist only for registered authenticated devices, not arbitrary IPs/tokens.
      let rate = rates.get(device.id);
      if (!rate || now - rate.since >= 60000) {
        rate = { since: now, count: 0 };
        rates.set(device.id, rate);
      }
      if (++rate.count > 120) {
        res.setHeader("Retry-After", "60");
        throw httpError(429, "设备上传请求过于频繁，请稍后重试");
      }
      next();
    } catch (error) { next(error); }
  });
  machineRouter.use(express.json({ limit: 2 * 1024 * 1024, strict: true, inflate: false }));

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
      validateEnvelope(req.body, device);
      const { pending, oldestPendingAt, lastError } = req.body;
      if (!Number.isSafeInteger(pending) || pending < 0 || (oldestPendingAt !== null && !iso(oldestPendingAt)) || (lastError !== null && !text(lastError, 256))) throw httpError(422, "设备心跳格式无效");
      transaction(db, () => {
        authorize(req);
        db.prepare("UPDATE cloud_devices SET last_seen_at=?,pending=?,oldest_pending_at=?,last_error=? WHERE id=?").run(new Date().toISOString(), pending, oldestPendingAt, lastError, device.id);
      });
      res.json({ protocolVersion: 1, deviceId: device.id });
      store.changed(currentRevision());
    } catch (error) { next(error); }
  });

  // Browser authentication, admin authorization and same-origin checks are required at the mount.
  adminRouter.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try { store.assertOpen(); next(); } catch (error) { next(error); }
  });
  adminRouter.get("/", (req, res) => res.json({ devices: store.devices() }));
  adminRouter.post("/", (req, res, next) => {
    try {
      validateDevice(req.body);
      const input = req.body;
      const secret = token();
      transaction(db, () => {
        if (findDevice.get(input.id)) throw httpError(409, "设备 ID 已存在");
        db.prepare("INSERT INTO cloud_devices(id,name,instrument_id,instrument_type,token_hash) VALUES(?,?,?,?,?)").run(input.id, input.name, input.instrumentId, input.instrumentType, hash(secret));
      });
      res.status(201).json({ device: publicDevice(findDevice.get(input.id)), token: secret });
      store.changed(currentRevision());
    } catch (error) { next(error); }
  });
  adminRouter.post("/:id/rotate", (req, res, next) => {
    try {
      const secret = token();
      transaction(db, () => {
        requireDevice(req.params.id);
        db.prepare("UPDATE cloud_devices SET token_hash=?,revoked=0 WHERE id=?").run(hash(secret), req.params.id);
      });
      rates.delete(req.params.id);
      res.json({ token: secret });
      store.changed(currentRevision());
    } catch (error) { next(error); }
  });
  adminRouter.delete("/:id", (req, res, next) => {
    try {
      transaction(db, () => {
        requireDevice(req.params.id);
        db.prepare("UPDATE cloud_devices SET revoked=1 WHERE id=?").run(req.params.id);
      });
      rates.delete(req.params.id);
      res.json({ device: publicDevice(findDevice.get(req.params.id)) });
      store.changed(currentRevision());
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
  return { store, machineRouter, adminRouter, status: () => store.status(), async close() { rates.clear(); await store.close(); } };
}
