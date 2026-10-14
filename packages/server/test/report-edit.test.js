import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createApplication } from "../src/app.js";

const date = "2026-09-23";
// Three measurements: max 61, min 12, average 25 — the same shape the record
// table and the list columns read.
const measurements = [
  [1, 11, 61, 1.31],
  [2, 5, 52, 1.33],
  [3, 14, 12, 1.49],
];
function reportFile(sample) {
  return [
    `Date ${date}_08-00-00`,
    "Sample Name " + sample,
    "Effective Tests 3",
    "MAX HARDNESS 61",
    "MIN HARDNESS 12",
    "AVERAGE HARDNESS 42",
    "TOTAL TESTS 3",
    "INVALID TESTS 0",
    "STEP 0.125",
    ...measurements.map((row) => row.join(" ")),
    "",
  ].join("\n");
}

// Reads the outbox bookkeeping for one report directly from the SQLite file, so
// the assertions do not depend on the worker's own view.
function fixtureVersions(home, reportId) {
  const db = new DatabaseSync(path.join(home, "lizi.sqlite"));
  try {
    return db
      .prepare("SELECT sequence, content_hash FROM sync_versions WHERE report_id=?")
      .get(reportId);
  } finally {
    db.close();
  }
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-edit-"));
  const root = path.join(home, "reports");
  const day = path.join(root, date, "instrument");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, "report.txt");
  const original = reportFile("4");
  await fs.writeFile(file, original);
  const older = new Date(Date.now() - 10000);
  await fs.utimes(file, older, older);
  const runtime = await createApplication({
    home,
    allowedRoots: JSON.stringify([root]),
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const localAdminToken = (
    await fs.readFile(path.join(home, "lan-admin-token.txt"), "utf8")
  ).trim();
  async function call(route, { method = "GET", body, localAdmin = true } = {}) {
    return fetch(`${origin}/api${route}`, {
      method,
      headers: {
        Origin: origin,
        "X-Lizi-Request": "1",
        ...(localAdmin ? { "X-Lizi-Local-Admin": localAdminToken } : {}),
        "Content-Type": "application/json",
      },
      cache: "no-cache",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  }
  assert.equal(
    (await call("/settings", { method: "PUT", body: { dataPath: root } })).status,
    200,
  );
  // Uploading needs a configured center identity: only then does a correction
  // become a new report version.
  assert.equal(
    (
      await call("/sync", {
        method: "PUT",
        body: { instrumentId: "01", instrumentType: "strength" },
      })
    ).status,
    200,
  );
  await call("/scan", { method: "POST", body: {} });
  let found;
  const deadline = Date.now() + 15000;
  do {
    const result = await (
      await call(`/reports?date=${date}&shift=day&page=1&pageSize=10`)
    ).json();
    found = result.reports?.find((entry) => entry.sampleName === "4");
    if (!found) await setTimeout(150);
  } while (!found && Date.now() < deadline);
  assert.ok(found, "报告未被索引");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fixtureVersions(home, found.id)) break;
    await setTimeout(100);
  }
  return {
    home,
    root,
    file,
    original,
    origin,
    call,
    report: found,
    versionRow(reportId) {
      return fixtureVersions(home, reportId);
    },
    current() {
      return this.call(`/reports?date=${date}&shift=day&page=1&pageSize=10`);
    },
  };
}

test("a corrected sample name re-derives the production line and stays in the index", async (t) => {
  const f = await fixture(t);
  assert.equal(f.report.line, 4);
  assert.equal(f.report.isAggregate, false);
  const before = f.versionRow(f.report.id);
  const revision = (await (await f.call("/status")).json()).revision;

  const edited = await f.call("/reports/edit", {
    method: "POST",
    body: { id: f.report.id, sampleName: "7总" },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), { id: f.report.id, changed: true });

  const result = await (await f.current()).json();
  const report = result.reports.find((entry) => entry.id === f.report.id);
  assert.equal(report.sampleName, "7总");
  assert.equal(report.line, 7, "产线必须随名称重新推导");
  assert.equal(report.isAggregate, true);
  assert.equal(result.revision, revision + 1, "修改必须让 revision 递增");
  assert.equal(
    await fs.readFile(f.file, "utf8"),
    f.original,
    "仪器原始文件不得被修改",
  );
  const after = f.versionRow(f.report.id);
  assert.ok(
    after.sequence > before.sequence,
    `修改必须作为新版本入队上报（${before.sequence} → ${after.sequence}）`,
  );
  assert.notEqual(after.content_hash, before.content_hash);

  // Repeating the same correction is a no-op, not a second version.
  const again = await f.call("/reports/edit", {
    method: "POST",
    body: { id: f.report.id, sampleName: "7总" },
  });
  assert.deepEqual(await again.json(), { id: f.report.id, changed: false });
  assert.equal(f.versionRow(f.report.id).sequence, after.sequence);
});

test("a corrected measurement re-derives the displayed hardness statistics", async (t) => {
  const f = await fixture(t);
  const edited = await f.call("/reports/edit", {
    method: "POST",
    body: { id: f.report.id, measurement: { index: 2, gram: 5 } },
  });
  assert.equal(edited.status, 200);
  const result = await (await f.current()).json();
  const report = result.reports.find((entry) => entry.id === f.report.id);
  assert.equal(report.testResults[2].gram, 5);
  assert.equal(report.minHardness, 5);
  assert.equal(report.maxHardness, 61);
  assert.equal(report.averageHardness, 39, "平均按整点取整：61+52+5 除以 3");
  // The instrument's own metrics are reported by the device and stay untouched.
  assert.equal(report.effectiveTests, 3);
  assert.equal(
    await fs.readFile(f.file, "utf8"),
    f.original,
    "仪器原始文件不得被修改",
  );
});

test("corrections are refused off the machine, without the token or with invalid values", async (t) => {
  const f = await fixture(t);
  const body = { id: f.report.id, sampleName: "8" };
  const noToken = await f.call("/reports/edit", {
    method: "POST",
    body,
    localAdmin: false,
  });
  assert.equal(noToken.status, 403);
  const noCsrf = await fetch(`${f.origin}/api/reports/edit`, {
    method: "POST",
    headers: { Origin: f.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(noCsrf.status, 403);
  for (const [payload, message] of [
    [{ id: "not-a-report", sampleName: "8" }, /标识/],
    [{ id: f.report.id }, /没有需要修改的内容/],
    [{ id: f.report.id, sampleName: "   " }, /不能为空/],
    [{ id: f.report.id, measurement: { index: 9, gram: 5 } }, /超出报告范围/],
    [{ id: f.report.id, measurement: { index: 0, gram: 1e9 } }, /强度必须为/],
  ]) {
    const response = await f.call("/reports/edit", { method: "POST", body: payload });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.match((await response.json()).error, message);
  }
  const unchanged = await (await f.current()).json();
  assert.equal(
    unchanged.reports.find((entry) => entry.id === f.report.id).sampleName,
    "4",
  );
});
