import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseReport } from "@lizi/core";
import { createApplication } from "../src/app.js";
import { openDatabase, setSetting } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";
import { createSyncClient } from "../src/sync-client.js";

const setupToken = "edit-test-bootstrap-token-must-stay-private";
const day = "2026-09-23";
const digest = (report) => createHash("sha256").update(JSON.stringify(report)).digest("hex");
const secretValue = () => randomBytes(32).toString("base64url");

// 中心报告标识是 设备ID+报告ID 的散列；设备端只认自己的 32 位十六进制标识。
const reportId = () => randomBytes(16).toString("hex");

function event({ reportId: id = reportId(), sequence = 1, sample = "1 sample", time = `${day}_08-00-00`, instrumentId = "A01" } = {}) {
  const report = parseReport(`Date ${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 3\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 3 0\n`);
  report.id = id;
  return { eventId: randomUUID(), reportId: id, sequence, contentHash: digest(report), instrumentId, instrumentType: "strength", schemaVersion: 1, parserVersion: 2, occurredAt: "2026-09-23T08:00:00.000Z", historical: true, report };
}

test("只读接口排队更正，心跳下发、回执后不再下发", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-edit-"));
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
  const read = async (route, method = "GET", body) => {
    const response = await fetch(origin + route, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
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

  const setup = await browser("/api/auth/setup", "POST", { token: setupToken, username: "admin", password: "strong-test-password" });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const deviceId = randomUUID();
  const secret = secretValue();
  assert.equal((await machine("/api/ingest/enroll", { protocolVersion: 1, deviceId, instrumentId: "A01", instrumentType: "strength", clientVersion: "3.1.8" }, secret)).status, 202);
  assert.equal((await browser(`/api/devices/${deviceId}/approve`, "POST", {}, cookie)).status, 200);
  const secondId = reportId();
  const rows = [
    event({ sample: "早班一", sequence: 1 }),
    event({ sample: "早班二", sequence: 2, time: `${day}_12-30-00`, reportId: secondId }),
  ];
  assert.equal((await machine("/api/ingest/reports", { protocolVersion: 1, deviceId, events: rows }, secret)).status, 200);

  const list = await read(`/api/read/reports?date=${day}&shift=day`);
  const target = list.body.reports.find((row) => row.sampleName === "早班二");
  const edit = (body) => read(`/api/read/reports/${target.id}/edit`, "POST", body);

  // 排队成功后设备下一次心跳就能取走；中心镜像此刻仍是旧值。
  const queued = await edit({ sampleName: "早班二改" });
  assert.equal(queued.status, 200);
  assert.deepEqual(
    { queued: queued.body.queued, changed: queued.body.changed, pending: queued.body.pending, deviceId: queued.body.deviceId },
    { queued: true, changed: true, pending: 1, deviceId },
  );
  assert.equal(typeof queued.body.deviceState, "string");
  assert.equal((await read(`/api/read/reports/${target.id}`)).body.report.sampleName, "早班二");

  const beat = (body = {}) => machine("/api/ingest/heartbeat", {
    protocolVersion: 1, deviceId, pending: 0, oldestPendingAt: null, lastError: null, acquisitionError: null, clientVersion: "3.1.8", ...body,
  }, secret);
  const first = await beat();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.edits.length, 1);
  assert.equal(firstBody.edits[0].reportId, secondId);
  assert.deepEqual(firstBody.edits[0].edit, { sampleName: "早班二改" });
  const editId = firstBody.edits[0].id;

  // 回执前重复心跳会重发同一条，设备重复应用得到 changed=false，不会产生多次版本。
  const repeated = await (await beat()).json();
  assert.equal(repeated.edits.length, 1);
  assert.equal(repeated.edits[0].id, editId);

  const ackResult = await machine("/api/ingest/edits/ack", { protocolVersion: 1, deviceId, results: [{ id: editId, ok: true, sequence: 3 }] }, secret);
  assert.equal(ackResult.status, 200);
  assert.deepEqual(await ackResult.json(), { protocolVersion: 1, deviceId, accepted: 1 });
  assert.deepEqual((await (await beat()).json()).edits, []);

  // 回执格式与归属都校验。
  assert.equal((await machine("/api/ingest/edits/ack", { protocolVersion: 1, deviceId, results: "nope" }, secret)).status, 422);
  assert.equal((await machine("/api/ingest/edits/ack", { protocolVersion: 1, deviceId, results: [{ id: 1.5, ok: true }] }, secret)).status, 422);
  assert.equal((await machine("/api/ingest/edits/ack", { protocolVersion: 1, deviceId, results: [{ id: editId, ok: "yes" }] }, secret)).status, 422);
  assert.equal((await machine("/api/ingest/edits/ack", { protocolVersion: 1, deviceId, results: [{ id: editId, ok: false, error: "x".repeat(201) }] }, secret)).status, 422);

  // 与真实报告一致时无需排队；非法字段、越界测点、未知报告分别拒绝。
  assert.deepEqual((await edit({ sampleName: "早班二" })).body, { queued: false, changed: false, pending: 0, deviceState: "online" });
  const tooLong = await edit({ sampleName: "名".repeat(121) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /120/);
  assert.equal((await edit({ sampleName: "" })).status, 400);
  assert.equal((await edit({ hardware: 1 })).status, 400);
  assert.equal((await edit({})).status, 400);
  assert.equal((await edit({ measurement: { index: 99, gram: 5 } })).status, 400);
  assert.equal((await edit({ measurement: { index: 0, gram: -1 } })).status, 400);
  assert.equal((await edit({ measurement: { index: 0, gram: 7 } })).body.queued, true);
  assert.equal((await read(`/api/read/reports/${"0".repeat(32)}/edit`, "POST", { sampleName: "x" })).status, 404);
  assert.equal((await read("/api/read/reports/not-a-report/edit", "POST", { sampleName: "x" })).status, 400);

  // 未启用的设备不再接受更正，避免排队到一台永远不上报的机器。
  assert.equal((await browser(`/api/devices/${deviceId}`, "DELETE", {}, cookie)).status, 200);
  assert.equal((await edit({ sampleName: "早班九" })).status, 409);
});

test("端到端：只读接口排队更正，设备心跳应用后回传新版本，中心镜像随之更新", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-edit-e2e-"));
  const runtime = await createApplication({ home, mode: "server", setupToken, trustProxy: "1" });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  await runtime.ready;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const deviceHome = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-edit-device-"));
  const root = path.join(deviceHome, "reports");
  await fs.mkdir(root);
  let db = openDatabase(deviceHome);
  setSetting(db, "dataPath", root);
  const policy = await createDirectoryPolicy(deviceHome, JSON.stringify([root]));
  const store = new ReportStore(db, policy);
  const deviceId = randomUUID();
  const client = await createSyncClient({
    home: deviceHome, db, localStore: store,
    options: { centerUrl: origin, allowLoopbackHttp: true, deviceId },
  });
  t.after(async () => {
    await client.close();
    await store.close();
    db.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(deviceHome, { recursive: true, force: true });
  });

  const sameOrigin = { Origin: origin, "X-Lizi-Request": "1", "Content-Type": "application/json" };
  const setup = await fetch(`${origin}/api/auth/setup`, {
    method: "POST", signal: AbortSignal.timeout(10000), headers: sameOrigin,
    body: JSON.stringify({ token: setupToken, username: "admin", password: "strong-test-password" }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const adminPost = (route) => fetch(origin + route, {
    method: "POST", signal: AbortSignal.timeout(10000), headers: { ...sameOrigin, Cookie: cookie }, body: "{}",
  });
  const deviceList = async () => {
    const response = await fetch(`${origin}/api/devices`, { signal: AbortSignal.timeout(10000), headers: { Cookie: cookie } });
    return (await response.json()).devices ?? [];
  };
  const readReport = async (id) => {
    const response = await fetch(`${origin}/api/read/reports/${id}`, { signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const waitFor = async (probe, label) => {
    for (let tries = 0; tries < 500; tries += 1) {
      const value = await probe();
      if (value) return value;
      await sleep(20);
    }
    throw new Error(label);
  };

  await store.start();
  await client.configure({ instrumentId: "A01", instrumentType: "strength" });
  await client.start();
  await waitFor(async () => (await deviceList()).some((device) => device.id === deviceId), "device should enroll");
  assert.equal((await adminPost(`/api/devices/${deviceId}/approve`)).status, 200);
  // 真实客户端每 30 秒轮询一次审批结果；测试里直接触发一次，避免等待。
  client.enroll();
  await sleep(50);

  // 只有活跃日期范围内的文件会被索引，用当天日期。
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const file = path.join(root, stamp, "instrument", "a.txt");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `Date ${stamp}_08-00-00\nSample Name 原始样品\nEffective Tests 1\nAVERAGE HARDNESS 3\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 3 0\n`);
  const older = new Date(Date.now() - 10000);
  await fs.utimes(file, older, older);
  await store.scan();
  const localId = db.prepare("SELECT id FROM reports").get().id;
  const centerId = await (async () => {
    for (let tries = 0; tries < 500; tries += 1) {
      const response = await fetch(`${origin}/api/read/reports?date=${stamp}&shift=day`, { signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (body.reports && body.reports.length) return body.reports[0].id;
      client.heartbeat();
      await sleep(20);
    }
    throw new Error("中心没有收到报告");
  })();

  const mirrored = async (sampleName) => {
    const one = await readReport(centerId);
    return one.status === 200 && one.body.report.sampleName === sampleName ? one : null;
  };
  const pump = async (sampleName) => {
    for (let tries = 0; tries < 500; tries += 1) {
      const one = await mirrored(sampleName);
      if (one) return one;
      client.heartbeat();
      await sleep(20);
    }
    throw new Error(`中心镜像未变为 ${sampleName}`);
  };
  await pump("原始样品");

  const queued = await fetch(`${origin}/api/read/reports/${centerId}/edit`, {
    method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sampleName: "远程更正" }),
  });
  assert.equal(queued.status, 200);
  assert.equal((await queued.json()).queued, true);

  // 设备心跳取走更正、在本地库生效，并把新版本回传中心。
  const mirror = await pump("远程更正");
  assert.equal(mirror.body.report.sampleName, "远程更正");
  assert.equal(JSON.parse(db.prepare("SELECT json FROM reports WHERE id=?").get(localId).json).sampleName, "远程更正");
});
