import ExcelJS from "exceljs";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { reportColumns } from "@lizi/core";
import { buildRecordSheets } from "../../../apps/web/src/report-record.js";
import { httpError } from "./directories.js";

const SUMMARY_ROWS = [
  ["max", "最大"],
  ["average", "平均"],
  ["min", "最小"],
];

// Record sheets mirror the on-screen 记录表 view: one worksheet per 炉号 (line),
// a column per report, twenty descending measurement rows and the summary rows.
async function writeRecordSheets(workbook, snapshot, yieldRows) {
  const reports = [];
  for await (const report of snapshot.reports) reports.push(report);
  const sheets = buildRecordSheets(reports);
  if (!sheets.length) throw httpError(400, "当前没有可导出的报告");
  const used = new Set();
  const headerRows = [];
  for (const sheet of sheets) {
    let name = sheet.title.replace(/[[\]:*?/\\]/g, "").slice(0, 31) || "记录表";
    for (let suffix = 2; used.has(name); suffix += 1)
      name = `${sheet.title.slice(0, 28)}(${suffix})`;
    used.add(name);
    const worksheet = workbook.addWorksheet(name);
    worksheet.columns = [
      { key: "label", width: 10 },
      ...sheet.columns.map((column, index) => ({
        key: `c${index}`,
        width: 12,
      })),
    ];
    // Style rows before commit: the streaming writer rejects committed rows.
    headerRows.push(
      worksheet.addRow(["日期", sheet.date]),
      worksheet.addRow(["时间", ...sheet.columns.map((column) => column.time)]),
      worksheet.addRow([
        "炉号",
        ...sheet.columns.map(() =>
          sheet.key === "unknown" ? null : Number(sheet.key),
        ),
      ]),
    );
    for (const headerRow of headerRows.splice(0)) {
      headerRow.font = { bold: true };
      headerRow.commit();
    }
    sheet.rows.forEach((row, index) => {
      worksheet.addRow([index + 1, ...row]).commit();
    });
    for (const [key, label] of SUMMARY_ROWS) {
      const row = worksheet.addRow([label, ...sheet.summary[key]]);
      row.font = { bold: true };
      row.commit();
    }
    await yieldRows();
  }
}

export async function exportReports(res, snapshot, date, shift, view = "list") {
  if (res.destroyed) throw new Error("导出连接已断开");
  if (!snapshot.count) throw httpError(400, "当前没有可导出的报告");
  if (snapshot.detailCount > 500000)
    throw httpError(413, "测试明细超过50万行，请分批选择导出");
  const name = `${date}${{ day: "白班", night: "夜班", full: "完整班次" }[shift]}-粒子强度数据.xlsx`;
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="reports-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "粒子强度工作台";
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  res.once("close", onClose);
  let rows = 0;
  async function yieldRows() {
    if (res.destroyed) throw new Error("导出连接已断开");
    if (++rows % 128 !== 0) return;
    if (res.writableNeedDrain)
      await once(res, "drain", { signal: disconnected.signal });
    await setImmediate();
  }
  try {
    if (view === "record") {
      await writeRecordSheets(workbook, snapshot, yieldRows);
    } else {
      await writeListSheets(workbook, snapshot, yieldRows);
    }
    await workbook.commit();
  } finally {
    res.removeListener("close", onClose);
  }
}

async function writeListSheets(workbook, snapshot, yieldRows) {
  const summary = workbook.addWorksheet("报告汇总", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const first = reportColumns.slice(0, 7);
  const remaining = reportColumns.slice(7);
  summary.columns = [
    ...first.map(([key, header]) => ({
      key,
      header,
      width: key === "sampleName" ? 24 : 16,
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      key: `test${index}`,
      header: `测试${index + 1}`,
      width: 12,
    })),
    ...remaining.map(([key, header]) => ({ key, header, width: 18 })),
    { key: "sourceName", header: "来源设备", width: 24 },
  ];
  const details = workbook.addWorksheet("全部测试明细", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  details.columns = [
    ["id", "报告ID", 34],
    ["date", "日期", 14],
    ["time", "时间", 12],
    ["line", "产线", 10],
    ["sampleName", "样品名称", 24],
    ["number", "编号", 12],
    ["test", "测试号", 12],
    ["gram", "硬度(g)", 14],
    ["mm", "直径(mm)", 14],
    ["sourceName", "来源设备", 24],
  ].map(([key, header, width]) => ({ key, header, width }));
  const segments = workbook.addWorksheet("分段统计", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  segments.columns = [
    ["id", "报告ID", 34],
    ["sampleName", "样品名称", 24],
    ["range", "范围", 18],
    ["stars", "分布", 40],
    ["sourceName", "来源设备", 24],
  ].map(([key, header, width]) => ({ key, header, width }));
  for (const sheet of [summary, details, segments]) {
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF17324D" },
    };
    sheet.getRow(1).commit();
  }
  // Finish one ZIP entry before filling the next worksheet; later entries
  // otherwise retain their rows while the summary entry is still open.
  for await (const report of snapshot.reports) {
    const row = Object.fromEntries(
      reportColumns.map(([key]) => [key, report[key]]),
    );
    row.isAggregate = report.isAggregate ? "是" : "否";
    row.sourceName = report.sourceName || "本机";
    for (let index = 0; index < 20; index += 1)
      row[`test${index}`] = report.testResults[index]?.gram ?? null;
    summary.addRow(row).commit();
    await yieldRows();
  }
  summary.commit();
  for await (const report of snapshot.reports) {
    for (const result of report.testResults) {
      details
        .addRow({
          id: report.id,
          date: report.date,
          time: report.time,
          line: report.line,
          sampleName: report.sampleName,
          sourceName: report.sourceName || "本机",
          ...result,
        })
        .commit();
      await yieldRows();
    }
  }
  details.commit();
  for await (const report of snapshot.reports) {
    for (const result of report.segmentInfoList) {
      segments
        .addRow({
          id: report.id,
          sampleName: report.sampleName,
          sourceName: report.sourceName || "本机",
          ...result,
        })
        .commit();
      await yieldRows();
    }
  }
  segments.commit();
}
