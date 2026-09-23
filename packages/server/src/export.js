import ExcelJS from "exceljs";
import { reportColumns } from "@lizi/core";
import { httpError } from "./directories.js";

export async function exportReports(res, reports, date, shift) {
  if (!reports.length) throw httpError(400, "当前没有可导出的报告");
  const detailCount = reports.reduce(
    (sum, report) =>
      sum + report.testResults.length + report.segmentInfoList.length,
    0,
  );
  if (detailCount > 500000)
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
  ].map(([key, header, width]) => ({ key, header, width }));
  const segments = workbook.addWorksheet("分段统计", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  segments.columns = [
    ["id", "报告ID", 34],
    ["sampleName", "样品名称", 24],
    ["range", "范围", 18],
    ["stars", "分布", 40],
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
  for (const report of reports) {
    if (res.destroyed) throw new Error("导出连接已断开");
    const row = Object.fromEntries(
      reportColumns.map(([key]) => [key, report[key]]),
    );
    row.isAggregate = report.isAggregate ? "是" : "否";
    for (let index = 0; index < 20; index += 1)
      row[`test${index}`] = report.testResults[index]?.gram ?? null;
    summary.addRow(row).commit();
    for (const result of report.testResults) {
      details
        .addRow({
          id: report.id,
          date: report.date,
          time: report.time,
          line: report.line,
          sampleName: report.sampleName,
          ...result,
        })
        .commit();
    }
    for (const result of report.segmentInfoList)
      segments
        .addRow({ id: report.id, sampleName: report.sampleName, ...result })
        .commit();
  }
  summary.commit();
  details.commit();
  segments.commit();
  await workbook.commit();
}
