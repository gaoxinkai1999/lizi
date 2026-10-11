import { createHash } from "node:crypto";
import { isDate, reportColumns } from "@lizi/core";
import { INSTRUMENT_TYPES, normalizeInstrumentId } from "../../core/src/deployment.js";
import { httpError } from "./directories.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SECRET = /^[A-Za-z0-9_-]{43}$/;
export const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const iso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
export const instrumentType = (id) => INSTRUMENT_TYPES.find((type) => type.id === id);

export function bearerSecret(req) {
  const match = /^Bearer ([^\s]+)$/.exec(req.get("authorization") ?? "");
  if (!match || !SECRET.test(match[1])) throw httpError(401, "缺少有效的设备密钥");
  return match[1];
}

const invalid = () => { throw httpError(422, "上传报告格式无效"); };
const stringFields = new Set(["operator", "testStandard", "crushDiameter", "breakAt"]);
const specialFields = new Set(["date", "time", "sampleName", "isAggregate"]);
const reportFields = new Set([...reportColumns.map(([key]) => key), "id", "testResults", "segmentInfoList", "instrumentId", "instrumentType", "schemaVersion", "parserVersion"]);

function strength(report, event) {
  if (!object(report) || Object.keys(report).some((key) => !reportFields.has(key))) invalid();
  if (!isDate(report.date) || typeof report.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(report.time) || !text(report.sampleName, 1024 * 1024) || typeof report.isAggregate !== "boolean") invalid();
  for (const [key] of reportColumns) {
    if (specialFields.has(key)) continue;
    const value = report[key];
    if (value !== null && (stringFields.has(key) ? !text(value, 1024 * 1024) : typeof value !== "number" || !Number.isFinite(value))) invalid();
  }
  if (report.id !== undefined && report.id !== event.reportId) invalid();
  for (const key of ["instrumentId", "instrumentType", "schemaVersion", "parserVersion"])
    if (report[key] !== undefined && report[key] !== event[key]) invalid();
  if (!Array.isArray(report.testResults) || !Array.isArray(report.segmentInfoList)) invalid();
  for (const row of report.testResults) {
    if (!object(row) || Object.keys(row).length !== 4 || !["number", "test", "gram", "mm"].every((key) => typeof row[key] === "number" && Number.isFinite(row[key]))) invalid();
  }
  for (const row of report.segmentInfoList) {
    if (!object(row) || Object.keys(row).length !== 2 || !text(row.range, 1024 * 1024) || typeof row.stars !== "string" || !/^\*+$/.test(row.stars)) invalid();
  }
}

const adapters = Object.freeze({ strength });
const eventFields = new Set(["eventId", "reportId", "sequence", "contentHash", "instrumentId", "instrumentType", "schemaVersion", "parserVersion", "occurredAt", "historical", "report"]);

export function validateEvent(event, device) {
  if (!object(event) || Object.keys(event).some((key) => !eventFields.has(key))) invalid();
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw httpError(413, "单个上传事件超过 1 MiB");
  if (typeof event.eventId !== "string" || !UUID.test(event.eventId) || !text(event.reportId) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !/^[a-f0-9]{64}$/.test(event.contentHash) || !Number.isSafeInteger(event.schemaVersion) || !Number.isSafeInteger(event.parserVersion) || !iso(event.occurredAt) || typeof event.historical !== "boolean") invalid();
  if (event.instrumentId !== device.instrument_id || event.instrumentType !== device.instrument_type) throw httpError(422, "上传仪器与设备注册信息不一致");
  const type = instrumentType(event.instrumentType);
  const adapter = type && Object.hasOwn(adapters, event.instrumentType) ? adapters[event.instrumentType] : undefined;
  if (!adapter) throw httpError(422, "不支持的仪器类型");
  if (event.schemaVersion !== type.schemaVersion || event.parserVersion !== type.parserVersion) invalid();
  adapter(event.report, event);
  const json = JSON.stringify(event.report);
  if (hash(json) !== event.contentHash) throw httpError(422, "上传报告内容校验失败");
  // Field order in the envelope is not identity; the exact report JSON is.
  const versionHash = hash(JSON.stringify([event.reportId, event.sequence, event.contentHash, event.instrumentId, event.instrumentType, event.schemaVersion, event.parserVersion, event.occurredAt, event.historical]));
  return { event, json, versionHash, id: hash(`${device.id}\0${event.reportId}`).slice(0, 32) };
}

const enrollFields = new Set(["protocolVersion", "deviceId", "instrumentId", "instrumentType", "clientVersion"]);

export function validateEnroll(body) {
  if (!object(body) || Object.keys(body).some((key) => !enrollFields.has(key))) throw httpError(422, "注册请求格式无效");
  if (body.protocolVersion !== 1) throw httpError(422, "注册协议版本无效");
  if (typeof body.deviceId !== "string" || !UUID.test(body.deviceId)) throw httpError(422, "设备 ID 无效");
  if (typeof body.instrumentType !== "string" || !instrumentType(body.instrumentType)) throw httpError(422, "不支持的仪器类型");
  if (typeof body.instrumentId !== "string") throw httpError(422, "仪器编号无效");
  let instrumentId;
  try { instrumentId = normalizeInstrumentId(body.instrumentId); }
  catch (error) { throw httpError(422, error.message); }
  if (typeof body.clientVersion !== "string" || !SEMVER.test(body.clientVersion)) throw httpError(422, "客户端版本无效");
  return { deviceId: body.deviceId, instrumentId, instrumentType: body.instrumentType, clientVersion: body.clientVersion };
}

const heartbeatFields = new Set(["protocolVersion", "deviceId", "pending", "oldestPendingAt", "lastError", "acquisitionError", "clientVersion"]);

export function validateHeartbeat(body, device) {
  if (!object(body) || Object.keys(body).some((key) => !heartbeatFields.has(key))) throw httpError(422, "设备心跳格式无效");
  validateEnvelope(body, device);
  const { pending, oldestPendingAt, lastError, acquisitionError, clientVersion } = body;
  const nullableIso = (value) => value === null || value === undefined || iso(value);
  const nullableText = (value) => value === null || value === undefined || text(value, 256);
  if (!Number.isSafeInteger(pending) || pending < 0 || pending > 1000000) throw httpError(422, "设备心跳格式无效");
  if (!nullableIso(oldestPendingAt) || !nullableText(lastError) || !nullableText(acquisitionError)) throw httpError(422, "设备心跳格式无效");
  if (clientVersion !== null && clientVersion !== undefined && !(typeof clientVersion === "string" && SEMVER.test(clientVersion))) throw httpError(422, "设备心跳格式无效");
  return { pending, oldestPendingAt: oldestPendingAt ?? null, lastError: lastError ?? null, acquisitionError: acquisitionError ?? null, clientVersion: clientVersion ?? null };
}

export function validateEnvelope(body, device) {
  if (!object(body) || body.protocolVersion !== 1) throw httpError(422, "上传协议无效");
  if (body.deviceId !== device.id) throw httpError(403, "设备 ID 与令牌不匹配");
}
