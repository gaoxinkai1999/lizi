import test from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import {
  applyReportEdit,
  decodeReport,
  filterReports,
  hardnessSummary,
  isAggregateSample,
  parseReport,
  sampleLine,
} from "../src/index.js";
import { buildRecordSheets } from "../src/report-record.js";

const zeroReport = `Operator 操作员甲
Date 2024-02-29_7-0-0
CUP 0
Sample Name 10 零值样品
Effective Tests 1
Test Standard ASTM D 4179
MAX HARDNESS 0.0
MIN HARDNESS 0.0
AVERAGE HARDNESS 0.0
HARDNESS DEVIATION 0.0
MAX DIAMETER 0.0
MIN DIAMETER 0.0
AVERAGE DIAMETER 0.0
DIAMETER DEVIATION 0.0
1 0 0.0 0.0
Segment Analysis
0-100 ***
AVERAGE OF TOP 25% 0.0
DEVIATION OF TOP 25% 0.0
TOTAL TESTS 1
INVALID TESTS 0
CRUSH DIAMETER 0%
BREAK AT 0 g
STEP 0.0
`;

test("GBK and UTF-8 reports preserve zero measurements, Chinese names and complete details", () => {
  for (const encoding of ["gbk", "utf8"]) {
    const report = parseReport(
      decodeReport(iconv.encode(zeroReport, encoding)),
    );
    assert.equal(report.operator, "操作员甲");
    assert.equal(report.sampleName, "10 零值样品");
    assert.equal(report.time, "07:00:00");
    assert.equal(report.line, 10);
    for (const key of [
      "cup",
      "maxHardness",
      "minHardness",
      "averageHardness",
      "hardnessDeviation",
      "maxDiameter",
      "minDiameter",
      "averageDiameter",
      "diameterDeviation",
      "averageOfTop25",
      "deviationOfTop25",
      "invalidTests",
      "step",
    ])
      assert.equal(report[key], 0, key);
    assert.deepEqual(report.testResults, [
      { number: 1, test: 0, gram: 0, mm: 0 },
    ]);
    assert.deepEqual(report.segmentInfoList, [
      { range: "0-100", stars: "***" },
    ]);
    assert.equal(report.testStandard, "ASTM D 4179");
  }
});

test("shift boundaries do not duplicate 19:00 or include next-day 07:00 across leap day", () => {
  const rows = [
    ["early", "2024-02-29", "06:59:59"],
    ["dayStart", "2024-02-29", "07:00:00"],
    ["dayEnd", "2024-02-29", "18:59:59"],
    ["nightStart", "2024-02-29", "19:00:00"],
    ["nightEnd", "2024-03-01", "06:59:59"],
    ["nextDay", "2024-03-01", "07:00:00"],
  ].map(([id, date, time]) => ({ id, date, time, line: 1 }));
  const ids = (shift) =>
    filterReports(rows, { date: "2024-02-29", shift }).map((row) => row.id);
  assert.deepEqual(ids("day"), ["dayStart", "dayEnd"]);
  assert.deepEqual(ids("night"), ["nightStart", "nightEnd"]);
  assert.deepEqual(ids("full"), [
    "dayStart",
    "dayEnd",
    "nightStart",
    "nightEnd",
  ]);
});

test("reports sort by time across production lines and exclude aggregates case insensitively", () => {
  const reports = [
    ["2 样品", "09"],
    ["10 样品", "08"],
    ["1 Z", "07"],
    ["3 总分析", "10"],
  ].map(([sample, hour]) =>
    parseReport(
      zeroReport
        .replace("10 零值样品", sample)
        .replace("_7-0-0", `_${hour}-0-0`),
    ),
  );
  assert.deepEqual(
    filterReports(reports, {
      date: "2024-02-29",
      shift: "full",
      excludeAggregate: true,
    }).map((row) => row.line),
    [10, 2],
  );
});

test("legacy reports retain available data without optional summaries or all declared details", () => {
  const report = parseReport(
    zeroReport
      .replace("2024-02-29_7-0-0", "2024-02-29_7-00-00")
      .replace("Effective Tests 1", "Effective Tests 3")
      .replace(
        /^(?:TOTAL TESTS|INVALID TESTS|AVERAGE HARDNESS|STEP).*\n/gm,
        "",
      ),
  );
  assert.equal(report.date, "2024-02-29");
  assert.equal(report.time, "07:00:00");
  assert.equal(report.sampleName, "10 零值样品");
  assert.equal(report.effectiveTests, 3);
  assert.equal(report.totalTests, null);
  assert.equal(report.invalidTests, null);
  assert.equal(report.averageHardness, null);
  assert.equal(report.step, null);
  assert.deepEqual(report.testResults, [
    { number: 1, test: 0, gram: 0, mm: 0 },
  ]);
});

test("invalid numeric fields and overflowing detail rows do not discard valid report data", () => {
  const report = parseReport(
    zeroReport
      .replace("CUP 0", "CUP invalid")
      .replace("Effective Tests 1", "Effective Tests unknown")
      .replace("AVERAGE HARDNESS 0.0", "AVERAGE HARDNESS N/A")
      .replace("STEP 0.0", "STEP 1e999")
      .replace("1 0 0.0 0.0", "2 1 1e999 1.0\n1 0 0.0 0.0"),
  );
  assert.equal(report.cup, null);
  assert.equal(report.effectiveTests, null);
  assert.equal(report.averageHardness, null);
  assert.equal(report.step, null);
  assert.equal(report.minHardness, 0);
  assert.deepEqual(report.testResults, [
    { number: 1, test: 0, gram: 0, mm: 0 },
  ]);
});

test("legacy whitespace and multiple detail groups per line preserve all measurements", () => {
  const report = parseReport(
    zeroReport
      .replace("Date 2024-02-29_7-0-0", "Date\f2024-02-29_7-00-00")
      .replace("Sample Name ", "Sample Name\n")
      .replace("CUP 0", "CUP\v0")
      .replace("Effective Tests 1", "Effective Tests\t3")
      .replace("1 0 0.0 0.0", "3 9 12.4 1.2\t1\v7\f9.8\t0.0\n2\n8 10.6 2.3")
      .replace("0-100 ***", "0-100 ***\t100-200 **"),
  );
  assert.equal(report.date, "2024-02-29");
  assert.equal(report.sampleName, "10 零值样品");
  assert.equal(report.cup, 0);
  assert.deepEqual(report.testResults, [
    { number: 1, test: 7, gram: 10, mm: 0 },
    { number: 2, test: 8, gram: 11, mm: 2.3 },
    { number: 3, test: 9, gram: 12, mm: 1.2 },
  ]);
  assert.deepEqual(report.segmentInfoList, [
    { range: "0-100", stars: "***" },
    { range: "100-200", stars: "**" },
  ]);
});

test("legacy segment ranges remain available without a section heading", () => {
  const report = parseReport(zeroReport.replace("Segment Analysis\n", ""));
  assert.deepEqual(report.segmentInfoList, [{ range: "0-100", stars: "***" }]);
});

test("invalid dates, missing sample names and non-report content remain rejected", () => {
  for (const content of [
    zeroReport.replace("2024-02-29", "2023-02-29"),
    zeroReport.replace("7-0-0", "24-00-00"),
    zeroReport.replace("Sample Name 10 零值样品\n", ""),
    zeroReport.replace("Sample Name 10 零值样品", "Sample Name"),
    zeroReport.replace("2024-02-29_7-0-0", ""),
    "Service started\nSample Name 10 日志\nEffective Tests 1",
    `${zeroReport}\0`,
    Buffer.from(zeroReport),
  ]) {
    assert.throws(() => parseReport(content));
  }
});

test("a corrected sample name re-derives the line and the aggregate flag exactly like parsing", () => {
  assert.equal(sampleLine("4"), 4);
  assert.equal(sampleLine("10 零值样品"), 10);
  assert.equal(sampleLine("A-4"), null);
  assert.equal(sampleLine(""), null);
  assert.equal(sampleLine(null), null);
  assert.equal(isAggregateSample("4总"), true);
  assert.equal(isAggregateSample("Z 样品"), true);
  assert.equal(isAggregateSample("4"), false);

  const report = parseReport(zeroReport);
  assert.equal(report.line, 10);
  assert.equal(report.isAggregate, false);
  const renamed = applyReportEdit(report, { sampleName: " 7总 " });
  assert.equal(renamed.changed, true);
  assert.equal(renamed.report.sampleName, "7总");
  assert.equal(renamed.report.line, 7);
  assert.equal(renamed.report.isAggregate, true);
  assert.equal(report.sampleName, "10 零值样品", "原始报告不得被就地修改");

  // A correction that changes nothing reports no change so the caller can skip
  // writing a new version.
  assert.equal(applyReportEdit(report, { sampleName: "10 零值样品" }).changed, false);
  assert.equal(applyReportEdit(report, {}).changed, false);
  for (const [edit, message] of [
    [{ sampleName: "" }, /不能为空/],
    [{ sampleName: "   " }, /不能为空/],
    [{ sampleName: "x".repeat(200) }, /不能超过/],
    [{ sampleName: "坏\u0000名" }, /不可用字符/],
    [{ sampleName: 7 }, /必须为文本/],
    [{ measurement: { index: -1, gram: 1 } }, /序号无效/],
    [{ measurement: { index: 5, gram: 1 } }, /超出报告范围/],
    [{ measurement: { index: 0, gram: "x" } }, /强度必须为/],
    [{ measurement: { index: 0, gram: -1 } }, /强度必须为/],
  ]) {
    assert.throws(() => applyReportEdit(report, edit), message);
  }
});

test("a corrected measurement re-derives the displayed statistics", () => {
  const report = parseReport(
    zeroReport.replace("1 0 0.0 0.0\n", "1 0 61 1.31\n2 0 52 1.33\n3 0 12 1.49\n"),
  );
  assert.deepEqual(
    { max: report.maxHardness, average: report.averageHardness, min: report.minHardness },
    { max: 0, average: 0, min: 0 },
    "解析出的统计仍来自仪器字段",
  );
  const edited = applyReportEdit(report, { measurement: { index: 2, gram: 5 } });
  assert.equal(edited.changed, true);
  assert.equal(edited.report.testResults[2].gram, 5);
  assert.equal(edited.report.maxHardness, 61);
  assert.equal(edited.report.minHardness, 5);
  assert.equal(edited.report.averageHardness, 39);
  assert.equal(edited.report.testResults[0].gram, 61, "其它测点不受影响");
  assert.deepEqual(hardnessSummary([]), {
    maxHardness: null,
    averageHardness: null,
    minHardness: null,
  });
});

test("record sheets keep the measurement index behind every displayed value", () => {
  const report = {
    id: "a".repeat(32),
    date: "2026-09-23",
    time: "08:00:00",
    line: 4,
    sampleName: "4",
    testResults: [
      { number: 1, test: 1, gram: 12, mm: 1.1 },
      { number: 2, test: 2, gram: 61, mm: 1.2 },
      { number: 3, test: 3, gram: 30, mm: 1.3 },
    ],
  };
  const [sheet] = buildRecordSheets([report]);
  assert.deepEqual(sheet.rows.slice(0, 3), [[61], [30], [12]]);
  assert.deepEqual(sheet.columns[0].indexes.slice(0, 3), [1, 2, 0]);
  assert.deepEqual(sheet.summary, { max: [61], min: [12], average: [34] });
});
