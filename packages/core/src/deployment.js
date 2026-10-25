export const CENTER_URL = "https://reports.abocidee.com";
export const APP_VERSION = "3.1.8";
export const INSTRUMENT_TYPES = Object.freeze([
  Object.freeze({ id: "strength", name: "强度仪", schemaVersion: 1, parserVersion: 2 }),
]);

export function normalizeInstrumentId(value) {
  if (typeof value !== "string") throw new Error("请输入仪器编号");
  const id = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(id))
    throw new Error("仪器编号使用 1–24 位字母、数字、短横线或下划线，例如 A01");
  return id;
}
