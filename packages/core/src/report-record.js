// One record sheet per line (炉号) and shift: a column per report in chronological
// order, twenty measurement rows sorted descending, and a per-column summary.
export const MEASUREMENT_ROWS = 20;

// Measurement rows sorted descending, keeping the index of each value inside the
// report's own testResults so a correction can target the exact measurement.
function measurementEntries(report) {
  return (report.testResults || [])
    .map((item, index) => ({ index, value: item.gram }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => b.value - a.value || a.index - b.index);
}

function lineKey(report) {
  if (report.line === null || report.line === undefined || report.line === "")
    return "unknown";
  return String(report.line);
}

function compareLines(a, b) {
  if (a === b) return 0;
  if (a === "unknown") return 1;
  if (b === "unknown") return -1;
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.localeCompare(b);
}

function compareChronological(a, b) {
  const left = `${a.date ?? ""} ${a.time ?? ""}`;
  const right = `${b.date ?? ""} ${b.time ?? ""}`;
  if (left !== right) return left.localeCompare(right);
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export function shortTime(value) {
  if (typeof value !== "string") return "";
  return /^\d{1,2}:\d{2}/.exec(value)?.[0] ?? value;
}

export function recordLabel(key) {
  return key === "unknown" ? "未标注炉号" : `${key} 号炉`;
}

export function buildRecordSheets(reports = []) {
  const groups = new Map();
  for (const report of reports) {
    const key = lineKey(report);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareLines(a, b))
    .map(([key, items]) => {
      const columns = [...items].sort(compareChronological);
      const entries = columns.map(measurementEntries);
      const values = entries.map((column) => column.map((entry) => entry.value));
      const rows = Array.from({ length: MEASUREMENT_ROWS }, (_, index) =>
        values.map((column) => column[index] ?? null),
      );
      const summary = {
        max: values.map((column) => (column.length ? column[0] : null)),
        min: values.map((column) =>
          column.length ? column[column.length - 1] : null,
        ),
        average: values.map((column) =>
          column.length
            ? Math.round(
                column.reduce((total, value) => total + value, 0) /
                  column.length,
              )
            : null,
        ),
      };
      return {
        key,
        label: recordLabel(key),
        title: `${recordLabel(key)}粒子强度记录表`,
        date: columns[0]?.date ?? "",
        columns: columns.map((report, index) => ({
          id: report.id,
          time: shortTime(report.time),
          sampleName: report.sampleName,
          // testResults index per displayed row, so an edited cell maps back to
          // the exact measurement.
          indexes: entries[index].map((entry) => entry.index),
        })),
        rows,
        summary,
      };
    });
}
