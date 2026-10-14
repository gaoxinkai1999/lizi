import iconv from "iconv-lite";

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const labels = [
  "Operator",
  "Date",
  "CUP",
  "Sample Name",
  "Effective Tests",
  "Test Standard",
  "MAX HARDNESS",
  "MIN HARDNESS",
  "AVERAGE HARDNESS",
  "HARDNESS DEVIATION",
  "MAX DIAMETER",
  "MIN DIAMETER",
  "AVERAGE DIAMETER",
  "DIAMETER DEVIATION",
  "AVERAGE OF TOP 25%",
  "DEVIATION OF TOP 25%",
  "TOTAL TESTS",
  "INVALID TESTS",
  "CRUSH DIAMETER",
  "BREAK AT",
  "STEP",
];
const escapeLabel = (label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nextField = new RegExp(
  `(?:^|\\s+)(?:${labels.map(escapeLabel).join("|")})(?=\\s|[:：]|$)`,
  "i",
);
const fieldPatterns = new Map(
  labels.map((label) => [
    label,
    new RegExp(
      `(?:^|\\s)${escapeLabel(label)}(?:\\s*[:：]\\s*|\\s+)([^\\n]*)`,
      "im",
    ),
  ]),
);

export function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function todayString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function nextDate(date) {
  if (!isDate(date)) throw new Error("日期必须为有效的 YYYY-MM-DD");
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function shiftBounds(date, shift = "day") {
  if (!isDate(date)) throw new Error("日期必须为有效的 YYYY-MM-DD");
  if (!["day", "night", "full"].includes(shift)) throw new Error("班次无效");
  return {
    start: `${date}T${shift === "night" ? "19" : "07"}:00:00`,
    end: shift === "day" ? `${date}T19:00:00` : `${nextDate(date)}T07:00:00`,
  };
}

export function filterReports(
  reports,
  { date, shift = "day", excludeAggregate = false },
) {
  const { start, end } = shiftBounds(date, shift);
  return reports
    .filter((report) => {
      const timestamp = `${report.date}T${report.time}`;
      return (
        timestamp >= start &&
        timestamp < end &&
        (!excludeAggregate || !report.isAggregate)
      );
    })
    .sort(
      (a, b) =>
        `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`) ||
        String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );
}

export function decodeReport(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    return iconv.decode(buffer, "utf16-le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return iconv.decode(buffer, "gbk");
  }
}

export function parseReport(content) {
  if (typeof content !== "string" || content.includes("\0"))
    throw new Error("不是有效的文本报告");
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const extract = (label) => {
    const match = fieldPatterns.get(label).exec(text);
    return match?.[1]?.split(nextField)[0]?.trim() || null;
  };
  const numeric = (label, round = false) => {
    const value = extract(label);
    if (value === null) return null;
    const match = new RegExp(`^(${NUMBER})(?:\\s|%|$)`).exec(value);
    if (!match || !Number.isFinite(Number(match[1]))) return null;
    return round ? Math.round(Number(match[1])) : Number(match[1]);
  };
  const dateTime = extract("Date");
  const match =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[_ T]+(\d{1,2})[-:](\d{1,2})[-:](\d{1,2})$/.exec(
      dateTime ?? "",
    );
  if (!match) throw new Error("缺少或无效的报告日期时间");
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  if (
    !isDate(date) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  )
    throw new Error("报告日期时间越界");
  const sampleName = extract("Sample Name");
  if (!sampleName) throw new Error("缺少样品名称");
  const report = {
    date,
    time: match
      .slice(4)
      .map((part) => part.padStart(2, "0"))
      .join(":"),
    line: sampleLine(sampleName),
    sampleName,
    operator: extract("Operator"),
    cup: numeric("CUP"),
    effectiveTests: numeric("Effective Tests"),
    testStandard: extract("Test Standard"),
    maxHardness: numeric("MAX HARDNESS", true),
    minHardness: numeric("MIN HARDNESS", true),
    averageHardness: numeric("AVERAGE HARDNESS", true),
    hardnessDeviation: numeric("HARDNESS DEVIATION"),
    maxDiameter: numeric("MAX DIAMETER"),
    minDiameter: numeric("MIN DIAMETER"),
    averageDiameter: numeric("AVERAGE DIAMETER"),
    diameterDeviation: numeric("DIAMETER DEVIATION"),
    averageOfTop25: numeric("AVERAGE OF TOP 25%"),
    deviationOfTop25: numeric("DEVIATION OF TOP 25%"),
    totalTests: numeric("TOTAL TESTS"),
    invalidTests: numeric("INVALID TESTS"),
    crushDiameter: extract("CRUSH DIAMETER"),
    breakAt: extract("BREAK AT"),
    step: numeric("STEP"),
    testResults: [],
    segmentInfoList: [],
    isAggregate: isAggregateSample(sampleName),
  };
  const [measurements, segments = text] = text.split(/Segment Analysis/i);
  const pattern = new RegExp(
    `(?:^|\\s)(\\d+)\\s+(\\d+)\\s+(${NUMBER})\\s+(${NUMBER})(?=\\s|$)`,
    "g",
  );
  for (const row of measurements.matchAll(pattern)) {
    const values = row.slice(1).map(Number);
    if (values.some((value) => !Number.isFinite(value))) continue;
    report.testResults.push({
      number: values[0],
      test: values[1],
      gram: Math.round(values[2]),
      mm: values[3],
    });
  }
  report.testResults.sort((a, b) => a.number - b.number);
  for (const row of segments.matchAll(
    /(?:^|\s)(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)\s+(\*+)(?=\s|$)/g,
  )) {
    report.segmentInfoList.push({
      range: row[1].replace(/\s/g, ""),
      stars: row[2],
    });
  }
  return report;
}

// The production line and the aggregate flag are derived from the sample name
// (leading digits, plus a "总"/"z" marker). Shared with the correction path so a
// corrected name re-derives exactly what the parser would have produced.
export function sampleLine(sampleName) {
  const name = typeof sampleName === "string" ? sampleName : "";
  return /^(\d+)(?=\D|$)/.test(name) ? Number(/^(\d+)/.exec(name)[1]) : null;
}

export function isAggregateSample(sampleName) {
  return /总|z/i.test(typeof sampleName === "string" ? sampleName : "");
}

export const REPORT_EDIT_NAME_LIMIT = 120;
export const REPORT_EDIT_GRAM_MIN = 0;
export const REPORT_EDIT_GRAM_MAX = 100000;

// The three displayed hardness statistics, recomputed from the measurement rows
// so a corrected value stays consistent with the table. Instrument-reported
// metrics that cannot be recomputed (deviations, top-25% figures, diameters)
// keep the values the instrument produced.
export function hardnessSummary(testResults) {
  const values = (Array.isArray(testResults) ? testResults : [])
    .map((row) => Number(row?.gram))
    .filter((value) => Number.isFinite(value));
  if (!values.length)
    return { maxHardness: null, averageHardness: null, minHardness: null };
  return {
    maxHardness: Math.round(Math.max(...values)),
    averageHardness: Math.round(
      values.reduce((total, value) => total + value, 0) / values.length,
    ),
    minHardness: Math.round(Math.min(...values)),
  };
}

// Applies a maintainer correction to a parsed report: a new sample name (which
// re-derives the production line and the aggregate flag) or one measurement
// value (which re-derives the displayed hardness statistics). Returns a copy;
// the caller decides whether to persist it.
export function applyReportEdit(report, edit = {}) {
  if (!report || typeof report !== "object") throw new Error("报告数据无效");
  const next = { ...report };
  let changed = false;
  if (edit.sampleName !== undefined) {
    if (typeof edit.sampleName !== "string")
      throw new Error("样品名称必须为文本");
    const sampleName = edit.sampleName.trim();
    if (!sampleName) throw new Error("样品名称不能为空");
    if (sampleName.length > REPORT_EDIT_NAME_LIMIT)
      throw new Error(`样品名称不能超过 ${REPORT_EDIT_NAME_LIMIT} 个字符`);
    if (/[\u0000-\u001f\u007f]/.test(sampleName))
      throw new Error("样品名称包含不可用字符");
    if (sampleName !== report.sampleName) {
      next.sampleName = sampleName;
      next.line = sampleLine(sampleName);
      next.isAggregate = isAggregateSample(sampleName);
      changed = true;
    }
  }
  if (edit.measurement !== undefined && edit.measurement !== null) {
    const { index, gram } = edit.measurement;
    if (!Number.isInteger(index) || index < 0)
      throw new Error("测点序号无效");
    const rows = Array.isArray(next.testResults) ? next.testResults : [];
    if (index >= rows.length) throw new Error("测点序号超出报告范围");
    const value = Number(gram);
    if (
      !Number.isFinite(value) ||
      value < REPORT_EDIT_GRAM_MIN ||
      value > REPORT_EDIT_GRAM_MAX
    )
      throw new Error(
        `强度必须为 ${REPORT_EDIT_GRAM_MIN}–${REPORT_EDIT_GRAM_MAX} 之间的数值`,
      );
    const rounded = Math.round(value);
    if (rows[index].gram !== rounded) {
      next.testResults = rows.map((row, position) =>
        position === index ? { ...row, gram: rounded } : row,
      );
      Object.assign(next, hardnessSummary(next.testResults));
      changed = true;
    }
  }
  return { report: next, changed };
}

export const reportColumns = [
  ["date", "日期"],
  ["time", "时间"],
  ["line", "产线"],
  ["sampleName", "样品名称"],
  ["maxHardness", "最大硬度"],
  ["minHardness", "最小硬度"],
  ["averageHardness", "平均硬度"],
  ["operator", "操作员"],
  ["cup", "杯号"],
  ["effectiveTests", "有效测试数"],
  ["testStandard", "测试标准"],
  ["hardnessDeviation", "硬度偏差"],
  ["maxDiameter", "最大直径"],
  ["minDiameter", "最小直径"],
  ["averageDiameter", "平均直径"],
  ["diameterDeviation", "直径偏差"],
  ["averageOfTop25", "前25%平均值"],
  ["deviationOfTop25", "前25%偏差"],
  ["totalTests", "总测试数"],
  ["invalidTests", "无效测试数"],
  ["crushDiameter", "压碎直径"],
  ["breakAt", "破碎点"],
  ["step", "步长"],
  ["isAggregate", "总分析"],
];
