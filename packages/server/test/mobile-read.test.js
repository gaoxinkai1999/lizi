import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseReport } from "@lizi/core";
import { createApplication } from "../src/app.js";

const setupToken = "read-test-bootstrap-token-must-stay-private";
const day = "2026-09-23";
const digest = (report) => createHash("sha256").update(JSON.stringify(report)).digest("hex");
const secretValue = () => randomBytes(32).toString("base64url");

function event({ reportId = `local-${randomUUID()}`, sequence = 1, sample = "1 sample", time = `${day}_08-00-00`, instrumentId = "A01" } = {}) {
  const report = parseReport(`Date ${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 3\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 3 0\n`);
  report.id = reportId;
  return { eventId: randomUUID(), reportId, sequence, contentHash: digest(report), instrumentId, instrumentType: "strength", schemaVersion: 1, parserVersion: 2, occurredAt: "2026-09-23T08:00:00.000Z", historical: true, report };
}

test("中心只读接口：无需登录即可读班次摘要与单份报告，会话接口不受影响", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-read-"));
  const runtime = await createApplication({ home, mode: "server", setupToken, trustProxy: "1" });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  await runtime.ready;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function read(route) {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }
  function browser(route, method, body, cookie) {
    return fetch(origin + route, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Origin: origin, "X-Lizi-Request": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  function machine(route, body, secret) {
    return fetch(origin + route, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
  }

  // 尚未初始化、也没有会话，只读接口依然可用，只是没有数据。
  const empty = await read(`/api/read/reports?date=${day}&shift=day`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {
    date: day, shift: "day", revision: 0, total: 0, truncated: false,
    summary: { pending: 0, online: 0, unstable: 0, offline: 0, revoked: 0, errors: 0 },
    sources: [], reports: [],
  });
  // 只读接口不改变原有鉴权：会话接口仍然要求登录。
  assert.equal((await fetch(`${origin}/api/reports?date=${day}&shift=day`)).status, 401);

  const setup = await browser("/api/auth/setup", "POST", { token: setupToken, username: "admin", password: "strong-test-password" });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const id = randomUUID();
  const secret = secretValue();
  const enroll = await machine("/api/ingest/enroll", { protocolVersion: 1, deviceId: id, instrumentId: "A01", instrumentType: "strength", clientVersion: "3.1.1" }, secret);
  assert.equal(enroll.status, 202);
  assert.equal((await browser(`/api/devices/${id}/approve`, "POST", {}, cookie)).status, 200);
  const rows = [
    event({ sample: "早班一", sequence: 1, time: `${day}_08-00-00` }),
    event({ sample: "早班二", sequence: 2, time: `${day}_12-30-00` }),
    event({ sample: "夜班三", sequence: 3, time: `${day}_03-00-00` }),
  ];
  assert.equal((await machine("/api/ingest/reports", { protocolVersion: 1, deviceId: id, events: rows }, secret)).status, 200);

  const list = await read(`/api/read/reports?date=${day}&shift=day`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  assert.equal(list.body.truncated, false);
  assert.equal(list.body.date, day);
  assert.equal(list.body.shift, "day");
  const [source] = list.body.sources;
  assert.equal(list.body.sources.length, 1);
  assert.equal(source.id, id);
  assert.equal(source.instrumentId, "A01");
  assert.equal(source.instrumentType, "strength");
  assert.equal(source.registrationState, "approved");
  assert.equal(source.connectionState, "online");
  assert.equal(source.state, "online");
  assert.equal(source.warning, null);
  assert.equal(source.hasError, false);
  assert.equal(typeof source.lastSeenAt, "string");

  // 最近的排在前，摘要不带逐次测量明细但给出条数。
  assert.deepEqual(list.body.reports.map((row) => row.sampleName), ["早班二", "早班一"]);
  const newest = list.body.reports[0];
  assert.ok(/^[a-f0-9]{32}$/.test(newest.id));
  assert.equal(newest.testResults, undefined);
  assert.equal(newest.segmentInfoList, undefined);
  assert.equal(newest.detailCount, rows[1].report.testResults.length);
  assert.equal(newest.instrumentId, "A01");
  assert.equal(newest.instrumentType, "strength");
  assert.equal(newest.sourceId, id);
  assert.equal(newest.sourceName, "A01");
  assert.equal(newest.date, day);
  assert.equal(newest.time, "12:30:00");

  // 单份报告给出完整字段与来源信息。
  const one = await read(`/api/read/reports/${newest.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.report.sampleName, "早班二");
  assert.deepEqual(one.body.report.testResults, rows[1].report.testResults);
  assert.deepEqual(one.body.report.segmentInfoList, rows[1].report.segmentInfoList);
  assert.equal(one.body.source.instrumentId, "A01");

  // 班次与日期过滤按核心班次边界执行：03:00 属于前一天的夜班。
  const night = await read(`/api/read/reports?date=2026-09-22&shift=night`);
  assert.equal(night.status, 200);
  assert.equal(night.body.total, 1);
  assert.deepEqual(night.body.reports.map((row) => row.sampleName), ["夜班三"]);

  // 没有数据的班次也要能区分「没有数据」与「仪器掉线」。
  const quiet = await read(`/api/read/reports?date=2026-10-01&shift=day`);
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.total, 0);
  assert.deepEqual(quiet.body.reports, []);
  assert.equal(quiet.body.sources.length, 1);

  // 参数与标识校验。
  assert.equal((await read(`/api/read/reports?date=${day}&shift=morning`)).status, 400);
  assert.equal((await read("/api/read/reports?date=2026-13-01")).status, 400);
  assert.equal((await read("/api/read/reports/not-a-report-id")).status, 400);
  assert.equal((await read(`/api/read/reports/${"0".repeat(32)}`)).status, 404);
});
