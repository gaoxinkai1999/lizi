import test from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { decodeReport, filterReports, parseReport } from "../src/index.js";

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

test("production line sorting is numeric and aggregate exclusion is case insensitive", () => {
  const reports = ["10 样品", "2 样品", "1 Z", "3 总分析"].map((sample) =>
    parseReport(zeroReport.replace("10 零值样品", sample)),
  );
  assert.deepEqual(
    filterReports(reports, {
      date: "2024-02-29",
      shift: "full",
      excludeAggregate: true,
    }).map((row) => row.line),
    [2, 10],
  );
});

test("half-written test details cannot become a complete report", () => {
  assert.throws(
    () => parseReport(zeroReport.replace("1 0 0.0 0.0\n", "")),
    /明细不足/,
  );
  assert.throws(
    () => parseReport(zeroReport.replace("STEP 0.0\n", "")),
    /完整/,
  );
});
