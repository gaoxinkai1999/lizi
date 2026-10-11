import { decodeReport, parseReport } from "./index.js";

const fileAdapters = Object.freeze({
  strength: Object.freeze({
    parse(buffer) {
      return parseReport(decodeReport(buffer));
    },
  }),
});

export function instrumentFileAdapter(type) {
  if (!Object.hasOwn(fileAdapters, type))
    throw new Error(`尚未安装仪器类型 ${type} 的文件解析适配器`);
  return fileAdapters[type];
}
