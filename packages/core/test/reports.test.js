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
