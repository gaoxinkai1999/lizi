import { createHash } from "node:crypto";
import { isDate, reportColumns } from "@lizi/core";
import { httpError } from "./directories.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const iso = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
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
  if (typeof event.eventId !== "string" || !UUID.test(event.eventId) || !text(event.reportId) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !/^[a-f0-9]{64}$/.test(event.contentHash) || event.schemaVersion !== 1 || event.parserVersion !== 2 || !iso(event.occurredAt) || typeof event.historical !== "boolean") invalid();
  if (event.instrumentId !== device.instrument_id || event.instrumentType !== device.instrument_type) throw httpError(422, "上传仪器与设备注册信息不一致");
  const adapter = Object.hasOwn(adapters, event.instrumentType) && adapters[event.instrumentType];
  if (!adapter) throw httpError(422, "不支持的仪器类型");
  adapter(event.report, event);
  const json = JSON.stringify(event.report);
  if (hash(json) !== event.contentHash) throw httpError(422, "上传报告内容校验失败");
  // Field order in the envelope is not identity; the exact report JSON is.
  const versionHash = hash(JSON.stringify([event.reportId, event.sequence, event.contentHash, event.instrumentId, event.instrumentType, event.schemaVersion, event.parserVersion, event.occurredAt, event.historical]));
  return { event, json, versionHash, id: hash(`${device.id}\0${event.reportId}`).slice(0, 32) };
}

export function validateDevice(input) {
  if (!object(input) || typeof input.id !== "string" || !UUID.test(input.id) || !text(input.name) || !text(input.instrumentId) || input.instrumentType !== "strength") throw httpError(422, "设备 ID、名称或仪器信息无效（仅支持 strength）");
}

export function validateEnvelope(body, device) {
  if (!object(body) || body.protocolVersion !== 1) throw httpError(422, "上传协议无效");
  if (body.deviceId !== device.id) throw httpError(403, "设备 ID 与令牌不匹配");
}
