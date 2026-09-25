import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import ExcelJS from "exceljs";
import { createApplication } from "../src/app.js";

const date = "2026-09-23";
function report(sample) {
  return `Date ${date}_08-00-00\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`;
}

test("date-scoped pages remain cacheable and cross-page/full exports preserve aggregate selection", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-query-"));
  const root = path.join(home, "reports");
  const day = path.join(root, date, "instrument");
  const history = path.join(root, "2000-01-01", "instrument");
  await fs.mkdir(day, { recursive: true });
  await fs.mkdir(history, { recursive: true });
  const older = new Date(Date.now() - 10000);
  for (let index = 0; index < 205; index++) {
    const file = path.join(day, `${index}.txt`);
    await fs.writeFile(
      file,
      report(`1 ${index % 100 === 0 ? "总分析" : "报告"}-${index}`),
    );
    await fs.utimes(file, older, older);
  }
  // Even matching content in an unrelated historical folder must not be indexed.
  const unrelated = path.join(history, "must-not-load.txt");
  await fs.writeFile(unrelated, report("99 历史目录不得加载"));
  await fs.utimes(unrelated, older, older);
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
  async function request(route, { method = "GET", body, headers = {} } = {}) {
    return fetch(`${origin}/api${route}`, {
      method,
      headers: {
        Origin: origin,
        "X-Lizi-Request": "1",
        "X-Lizi-Local-Admin": localAdminToken,
        "Content-Type": "application/json",
        ...headers,
      },
      cache: "no-cache",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  }
  assert.equal(
    (await request("/settings", { method: "PUT", body: { dataPath: root } }))
      .status,
    200,
  );
  const configured = await (await request("/status")).json();
  assert.equal(
    configured.reportCount,
    0,
    "configuring a historical root must not index it",
  );
  const query = `/reports?date=${date}&shift=day`;
  let first;
  const deadline = Date.now() + 15000;
  do {
    first = await (await request(query)).json();
    if (!first.indexing) break;
    await setTimeout(25);
  } while (Date.now() < deadline);
  assert.equal(first.indexing, false);
  assert.equal(first.total, 205);
  assert.equal(first.reports.length, 100);
  const second = await (await request(`${query}&page=2`)).json();
  const third = await (await request(`${query}&page=3`)).json();
  const all = [...first.reports, ...second.reports, ...third.reports];
  assert.equal(third.reports.length, 5);
  assert.equal(new Set(all.map((value) => value.id)).size, 205);
  assert.ok(all.every((value) => value.line === 1));
  assert.equal((await request(`${query}&pageSize=101`)).status, 400);
  const cached = await request(query, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(cached.headers.get("content-encoding"), "gzip");
  const tag = cached.headers.get("etag");
  await cached.arrayBuffer();
  assert.ok(tag);
  assert.equal(
    (await request(query, { headers: { "If-None-Match": tag } })).status,
    304,
  );

  async function exportRows(selection) {
    const response = await request("/reports/export", {
      method: "POST",
      body: { date, shift: "day", ...selection },
    });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    return workbook.worksheets.map((sheet) => sheet.rowCount - 1);
  }
  assert.deepEqual(await exportRows({}), [202, 202, 0]);
  assert.deepEqual(await exportRows({ allSelected: true }), [205, 205, 0]);
  const selected = [first.reports[0].id, third.reports[4].id];
  assert.deepEqual(await exportRows({ ids: selected }), [2, 2, 0]);
  const invalid = await request("/reports/export", {
    method: "POST",
    body: { date, ids: ["f".repeat(32)] },
  });
  assert.equal(invalid.status, 409);
});
