import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { parseReport } from "@lizi/core";
import { openDatabase } from "../src/database.js";
import { createCloud } from "../src/cloud.js";
import { hash } from "../src/cloud-protocol.js";

const date = "2026-09-23";
const query = { date, shift: "day" };
const digest = (report) => createHash("sha256").update(JSON.stringify(report)).digest("hex");
const secretValue = () => randomBytes(32).toString("base64url");
const uniqueInstrumentId = () => `S${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
const DEVICE_VIEW_KEYS = ["id", "name", "location", "instrumentId", "instrumentType", "registrationState", "connectionState", "lastSeenAt", "lastReceivedAt", "pending", "oldestPendingAt", "lastError", "acquisitionError", "clientVersion", "offlineSince", "connected"];

function event(reportId = "local-report", sequence = 1, sample = "1 sample", time = `${date}_08-00-00`, instrumentId = "A01") {
  const report = parseReport(`Date ${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 3\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 3 0\n`);
  report.id = reportId;
  return { eventId: randomUUID(), reportId, sequence, contentHash: digest(report), instrumentId, instrumentType: "strength", schemaVersion: 1, parserVersion: 2, occurredAt: "2026-09-23T08:00:00.000Z", historical: true, report };
}

async function fixture(t, cloudOptions = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-cloud-"));
  let db, cloud, server, origin;
  async function start() {
    db = openDatabase(home);
    cloud = await createCloud({ home, db, options: cloudOptions });
    const app = express();
    app.use("/ingest", cloud.machineRouter);
    app.use(express.json());
    app.use("/devices", cloud.adminRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await cloud.close();
    db.close();
  }
  await start();
  t.after(async () => { await stop(); await fs.rm(home, { recursive: true, force: true }); });
  async function request(route, body, secret, method = "POST") {
    return fetch(`${origin}${route}`, { method, headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  async function enroll({ deviceId = randomUUID(), instrumentId = uniqueInstrumentId(), instrumentType = "strength", clientVersion = "3.1.0", secret = secretValue(), body } = {}) {
    const payload = body ?? { protocolVersion: 1, deviceId, instrumentId, instrumentType, clientVersion };
    const response = await request("/ingest/enroll", payload, secret);
    return { response, deviceId, instrumentId, clientVersion, secret };
  }
  async function approve(id) { return request(`/devices/${id}/approve`, {}); }
  async function revoke(id) { return request(`/devices/${id}`, {}, undefined, "DELETE"); }
  async function approved(overrides = {}) {
    const device = await enroll(overrides);
    assert.equal(device.response.status, 202);
    assert.equal((await approve(device.deviceId)).status, 200);
    return device;
  }
  async function upload(device, events) {
    return request("/ingest/reports", { protocolVersion: 1, deviceId: device.deviceId, events }, device.secret);
  }
  async function heartbeat(device, body) {
    return request("/ingest/heartbeat", { protocolVersion: 1, deviceId: device.deviceId, ...body }, device.secret);
  }
  async function list() { return (await request("/devices", undefined, undefined, "GET")).json(); }
  async function device(id) { return (await list()).devices.find((item) => item.id === id); }
  function setLastSeen(id, ms) { db.prepare("UPDATE cloud_devices SET last_seen_at=? WHERE id=?").run(new Date(Date.now() - ms).toISOString(), id); }
  return { get db() { return db; }, get cloud() { return cloud; }, request, enroll, approve, revoke, approved, upload, heartbeat, list, device, setLastSeen, async restart() { await stop(); await start(); } };
}

async function collect(snapshot) {
  const rows = [];
  for await (const row of snapshot.reports) rows.push(row);
  return rows;
}

test("客户端自助注册与管理员审批控制上传，凭据不变且停用不删除报告", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const secret = secretValue();
  const first = await f.enroll({ deviceId: id, instrumentId: "A01", secret });
  assert.equal(first.response.status, 202);
  assert.deepEqual(await first.response.json(), { protocolVersion: 1, deviceId: id, registrationState: "pending" });
  assert.equal(f.db.prepare("SELECT token_hash FROM cloud_devices WHERE id=?").get(id).token_hash, hash(secret));

  // Repeating the same UUID + secret keeps the same state and response shape.
  const repeat = await f.enroll({ deviceId: id, instrumentId: "A01", secret });
  assert.equal(repeat.response.status, 202);
  assert.deepEqual(await repeat.response.json(), { protocolVersion: 1, deviceId: id, registrationState: "pending" });

  // Another credential must never take over or re-enroll an existing id.
  assert.equal((await f.enroll({ deviceId: id, instrumentId: "A01", secret: secretValue() })).response.status, 401);
  assert.equal((await f.request("/ingest/enroll", { protocolVersion: 1, deviceId: id, instrumentId: "A01", instrumentType: "strength", clientVersion: "3.1.0" })).status, 401);
  assert.equal((await f.enroll({ deviceId: randomUUID(), instrumentId: "A01", secret: "too-short-secret" })).response.status, 401);

  // An already-used credential cannot be bound to a second device.
  assert.equal((await f.enroll({ instrumentId: "B01", secret })).response.status, 401);

  // Duplicate short IDs against another device are conflicts.
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 409);

  // Pending devices cannot upload.
  assert.equal((await f.upload(first, [event("pending-report", 1, "1 sample", undefined, "A01")])).status, 403);

  // The 3.0 manual register/rotate endpoints are gone.
  assert.equal((await f.request("/devices", { id: randomUUID(), name: "x", instrumentId: "A01", instrumentType: "strength" })).status, 404);
  assert.equal((await f.request(`/devices/${id}/rotate`, {})).status, 404);

  // Approval enables upload automatically with the same credential.
  assert.equal((await f.approve(id)).status, 200);
  const approvedRepeat = await f.enroll({ deviceId: id, instrumentId: "A01", secret });
  assert.equal(approvedRepeat.response.status, 200);
  assert.deepEqual(await approvedRepeat.response.json(), { protocolVersion: 1, deviceId: id, registrationState: "approved" });
  assert.equal((await f.upload(first, [event("r1", 1, "1 sample", undefined, "A01")])).status, 200);
  const listed = await f.list();
  assert.equal(JSON.stringify(listed).includes(secret), false);

  // Revocation withdraws upload permission but keeps every stored report.
  const revoked = await f.revoke(id);
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).device.registrationState, "revoked");
  const revokedEnroll = await f.enroll({ deviceId: id, instrumentId: "A01", secret });
  assert.equal(revokedEnroll.response.status, 200);
  assert.deepEqual(await revokedEnroll.response.json(), { protocolVersion: 1, deviceId: id, registrationState: "revoked" });
  assert.equal((await f.upload(first, [event("r2", 1, "1 sample", undefined, "A01")])).status, 401);
  assert.equal((await f.cloud.store.query(query)).total, 1);

  // Re-approval restores the original secret and the client recovers automatically.
  assert.equal((await f.approve(id)).status, 200);
  assert.equal((await f.upload(first, [event("r3", 1, "1 sample", undefined, "A01")])).status, 200);
  assert.equal((await f.cloud.store.query(query)).total, 2);

  // Going offline never revokes or deletes: an aged approved device still uploads.
  f.setLastSeen(id, 600000);
  assert.equal((await f.device(id)).connectionState, "offline");
  assert.equal((await f.device(id)).registrationState, "approved");
  assert.equal((await f.upload(first, [event("r4", 1, "1 sample", undefined, "A01")])).status, 200);
  assert.equal((await f.cloud.store.query(query)).total, 3);
});

test("注册请求受每 IP 与全局速率限制且状态有界", async (t) => {
  const f = await fixture(t, { enroll: { perIp: 2, global: 100, windowMs: 60000 } });
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 202);
  assert.equal((await f.enroll({ instrumentId: "B01" })).response.status, 202);
  const third = await f.enroll({ instrumentId: "C01" });
  assert.equal(third.response.status, 429);
  assert.equal(third.response.headers.get("retry-after"), "60");
  assert.equal(f.cloud.store.devices().length, 2, "被限流的请求不得写入设备");
});

test("注册请求的全局上限不区分来源", async (t) => {
  const f = await fixture(t, { enroll: { perIp: 100, global: 2, windowMs: 60000 } });
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 202);
  assert.equal((await f.enroll({ instrumentId: "B01" })).response.status, 202);
  assert.equal((await f.enroll({ instrumentId: "C01" })).response.status, 429);
});

test("注册请求限制待审批数量并拒绝超限请求体", async (t) => {
  const f = await fixture(t, { enroll: { perIp: 100, global: 1000, maxPending: 1 } });
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 202);
  assert.equal((await f.enroll({ instrumentId: "B01" })).response.status, 429);
  const oversized = { protocolVersion: 1, deviceId: randomUUID(), instrumentId: "C01", instrumentType: "strength", clientVersion: "3.1.0", padding: "x".repeat(9000) };
  assert.equal((await f.request("/ingest/enroll", oversized, secretValue())).status, 413);
  assert.equal(f.cloud.store.devices().filter((device) => device.registrationState === "pending").length, 1);
});

test("待审批的错误申请可被拒绝并释放编号与密钥", async (t) => {
  const f = await fixture(t);
  const bogus = await f.enroll({ instrumentId: "A01" });
  assert.equal(bogus.response.status, 202);
  // While the bogus application holds the short ID the real device is blocked.
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 409);
  const rejected = await f.revoke(bogus.deviceId);
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { device: null, rejected: true });
  assert.equal(f.cloud.store.devices().length, 0);
  // The freed short ID and secret enroll normally afterwards.
  const real = await f.enroll({ deviceId: bogus.deviceId, instrumentId: "A01", secret: bogus.secret });
  assert.equal(real.response.status, 202);
  assert.equal((await f.approve(bogus.deviceId)).status, 200);
  assert.equal((await f.upload(real, [event("r1", 1, "1 sample", undefined, "A01")])).status, 200);
  // An approved device then stopped keeps its number and its reports.
  assert.equal((await f.revoke(bogus.deviceId)).status, 200);
  assert.equal((await f.device(bogus.deviceId)).registrationState, "revoked");
  assert.equal((await f.cloud.store.query(query)).total, 1);
  assert.equal((await f.enroll({ instrumentId: "A01" })).response.status, 409);
});

test("未产生报告前可用相同密钥更正仪器编号，产生报告后锁定", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const secret = secretValue();
  assert.equal((await f.enroll({ deviceId: id, instrumentId: "A01", secret })).response.status, 202);
  // Correcting the short ID before any event is allowed and keeps the pending state.
  const corrected = await f.enroll({ deviceId: id, instrumentId: "A02", secret });
  assert.equal(corrected.response.status, 202);
  assert.deepEqual(await corrected.response.json(), { protocolVersion: 1, deviceId: id, registrationState: "pending" });
  assert.equal((await f.device(id)).instrumentId, "A02");
  assert.equal((await f.device(id)).name, "A02", "默认名称随编号更新");
  // A short ID already held by another device still conflicts.
  assert.equal((await f.enroll({ instrumentId: "B01" })).response.status, 202);
  assert.equal((await f.enroll({ deviceId: id, instrumentId: "B01", secret })).response.status, 409);
  // After approval and one stored report the identity is locked.
  assert.equal((await f.approve(id)).status, 200);
  assert.equal((await f.upload({ deviceId: id, secret }, [event("r1", 1, "1 sample", undefined, "A02")])).status, 200);
  assert.equal((await f.enroll({ deviceId: id, instrumentId: "A03", secret })).response.status, 409);
  assert.equal((await f.device(id)).instrumentId, "A02");
});

test("设备列表精确反映注册/连接状态、空值与汇总，且不用最近上传推断离线", async (t) => {
  const f = await fixture(t);
  const a = await f.approved({ instrumentId: "A01" });
  let view = await f.device(a.deviceId);
  assert.deepEqual(Object.keys(view), DEVICE_VIEW_KEYS);
  assert.equal(view.registrationState, "approved");
  assert.equal(view.connectionState, "offline", "从未连接过的已批准设备为离线");
  assert.equal(view.offlineSince, null);
  assert.equal(view.connected, false);
  assert.equal(view.pending, null, "未知待上传数量返回 null 而不是 0");
  assert.equal(view.oldestPendingAt, null);
  assert.equal(view.lastSeenAt, null);
  assert.equal(view.lastReceivedAt, null);
  assert.equal(view.lastError, null);
  assert.equal(view.acquisitionError, null);
  assert.equal(view.clientVersion, "3.1.0");

  // Heartbeat keeps upload and acquisition errors separate and reports an exact version.
  assert.equal((await f.heartbeat(a, { pending: 5, oldestPendingAt: "2026-09-20T10:00:00.000Z", lastError: null, acquisitionError: "采集目录不可写", clientVersion: "3.1.2" })).status, 200);
  view = await f.device(a.deviceId);
  assert.equal(view.connectionState, "online");
  assert.equal(view.connected, true);
  assert.equal(view.pending, 5);
  assert.equal(view.oldestPendingAt, "2026-09-20T10:00:00.000Z");
  assert.equal(view.acquisitionError, "采集目录不可写");
  assert.equal(view.lastError, null);
  assert.equal(view.clientVersion, "3.1.2");
  assert.equal(view.lastReceivedAt, null, "心跳不应伪造报告接收时间");

  // Zero backlog alone never proves completeness.
  assert.equal((await f.heartbeat(a, { pending: 0, oldestPendingAt: null, lastError: null, acquisitionError: null, clientVersion: "3.1.2" })).status, 200);
  const result = await f.cloud.store.query(query);
  assert.equal(result.sources[0].pending, 0);
  assert.equal(result.sources[0].complete, false);

  // Old clients may omit the optional fields; the last known version is preserved.
  assert.equal((await f.heartbeat(a, { pending: 0, oldestPendingAt: null, lastError: null })).status, 200);
  assert.equal((await f.device(a.deviceId)).clientVersion, "3.1.2");
  assert.equal((await f.heartbeat(a, { pending: 0, oldestPendingAt: null, lastError: "网络失败" })).status, 200);

  // Connection states follow last-seen time only.
  f.setLastSeen(a.deviceId, 10000);
  assert.equal((await f.device(a.deviceId)).connectionState, "online");
  f.setLastSeen(a.deviceId, 120000);
  assert.equal((await f.device(a.deviceId)).connectionState, "unstable");
  f.setLastSeen(a.deviceId, 300000);
  view = await f.device(a.deviceId);
  assert.equal(view.connectionState, "offline");
  assert.equal(view.connected, false);
  assert.equal(view.offlineSince, new Date(Date.parse(view.lastSeenAt) + 180000).toISOString());

  // Pending and revoked take precedence over connection state.
  const pending = await f.enroll({ instrumentId: "B01" });
  assert.equal(pending.response.status, 202);
  const revoked = await f.approved({ instrumentId: "C01" });
  assert.equal((await f.revoke(revoked.deviceId)).status, 200);
  const pendingView = await f.device(pending.deviceId);
  assert.equal(pendingView.registrationState, "pending");
  assert.equal(pendingView.connectionState, "pending");
  assert.equal(pendingView.connected, false);
  const revokedView = await f.device(revoked.deviceId);
  assert.equal(revokedView.registrationState, "revoked");
  assert.equal(revokedView.connectionState, "revoked");
  assert.equal(revokedView.connected, false);

  const listed = await f.list();
  assert.deepEqual(listed.summary, { pending: 1, online: 0, unstable: 0, offline: 1, revoked: 1, errors: 1 });
  const source = (await f.cloud.store.query(query)).sources.find((item) => item.id === a.deviceId);
  assert.equal(source.state, "offline");
  assert.equal(source.warning, "离线");

  // Display metadata only; instrument identity can never change through the API.
  const patched = await f.request(`/devices/${a.deviceId}`, { name: "车间一号", location: "一号车间" }, undefined, "PATCH");
  assert.equal(patched.status, 200);
  const patchedView = (await patched.json()).device;
  assert.equal(patchedView.name, "车间一号");
  assert.equal(patchedView.location, "一号车间");
  assert.equal(patchedView.instrumentId, "A01");
  assert.equal((await f.request(`/devices/${a.deviceId}`, { instrumentId: "Z99" }, undefined, "PATCH")).status, 422);
  assert.equal((await f.request(`/devices/${a.deviceId}`, {}, undefined, "PATCH")).status, 422);
  assert.equal((await f.request(`/devices/${a.deviceId}`, { name: "" }, undefined, "PATCH")).status, 422);
  assert.equal((await f.request(`/devices/${a.deviceId}`, { name: "车间一号", location: null }, undefined, "PATCH")).status, 200);
  assert.equal((await f.device(a.deviceId)).location, null);
});

test("连接状态随时间迁移，仅在有变化时广播", async (t) => {
  const f = await fixture(t, { onlineAfterMs: 1000, unstableAfterMs: 2000, transitionIntervalMs: 0 });
  const a = await f.approved({ instrumentId: "A01" });
  const store = f.cloud.store;
  const seen = [];
  store.on("devices", (snapshot) => seen.push(snapshot.devices.find((device) => device.id === a.deviceId).connectionState));
  f.setLastSeen(a.deviceId, 300);
  store.refreshConnections();
  f.setLastSeen(a.deviceId, 1500);
  store.refreshConnections();
  f.setLastSeen(a.deviceId, 300);
  store.refreshConnections();
  f.setLastSeen(a.deviceId, 9000);
  store.refreshConnections();
  store.refreshConnections();
  assert.deepEqual(seen, ["online", "unstable", "online", "offline"], "相同状态不重复广播");

  const snapshot = store.deviceSnapshot();
  assert.ok(Array.isArray(snapshot.devices));
  assert.deepEqual(Object.keys(snapshot.summary).sort(), ["errors", "offline", "online", "pending", "revoked", "unstable"]);
  const status = store.status();
  assert.equal(status.sources[0].connectionState, "offline");
  assert.equal(status.sources[0].state, "offline");
  assert.equal(status.summary.offline, 1);
});

test("durable receipt replay after lost acknowledgement and restart preserves newest report", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  const original = event();
  const first = await f.upload(device, [original]);
  assert.equal(first.status, 200);
  await first.arrayBuffer(); // Simulate a committed delivery whose acknowledgement was not applied.
  await f.restart();
  const replay = await f.upload(device, [original]);
  assert.deepEqual((await replay.json()).acknowledgements, [{ eventId: original.eventId, reportId: original.reportId, sequence: 1, contentHash: original.contentHash }]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_receipts").get().n, 1);
  const latest = event(original.reportId, 3, "1 latest");
  assert.equal((await f.upload(device, [latest])).status, 200);
  assert.equal((await f.upload(device, [event(original.reportId, 2, "1 stale")])).status, 200);
  assert.equal((await f.upload(device, [original])).status, 200);
  const result = await f.cloud.store.query(query);
  assert.equal(result.total, 1);
  assert.equal(result.reports[0].sampleName, "1 latest");
  assert.equal(result.revision, 2);
  assert.equal(f.db.prepare("SELECT historical FROM cloud_versions WHERE sequence=1").get().historical, 1);
});

test("batch validation and identity conflicts rollback the entire batch", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  const saved = event();
  assert.equal((await f.upload(device, [saved])).status, 200);
  const changed = event(saved.reportId, saved.sequence, "1 conflicting");
  assert.equal((await f.upload(device, [event("new-one"), changed])).status, 409);
  assert.equal((await f.cloud.store.query(query)).total, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_receipts").get().n, 1);
  const sameEvent = { ...event("different-report"), eventId: saved.eventId };
  assert.equal((await f.upload(device, [sameEvent])).status, 409);
  const badHash = { ...event("bad"), contentHash: "0".repeat(64) };
  assert.equal((await f.upload(device, [event("must-rollback"), badHash])).status, 422);
  assert.equal((await f.cloud.store.query(query)).total, 1);
  const leakedPath = event("path");
  leakedPath.report.path = "C:\\private\\report.txt";
  leakedPath.contentHash = digest(leakedPath.report);
  assert.equal((await f.upload(device, [leakedPath])).status, 422);
  const unsupported = { ...event("wrong-parser"), parserVersion: 3 };
  assert.equal((await f.upload(device, [unsupported])).status, 422);
  const changedOrder = event("exact-hash");
  changedOrder.report = Object.fromEntries(Object.entries(changedOrder.report).reverse());
  assert.equal((await f.upload(device, [changedOrder])).status, 422, "wire report serialization, not semantic object equality, defines content hash");
});

test("credential-bound identity isolates devices without deleting reports", async (t) => {
  const f = await fixture(t);
  const a = await f.approved({ instrumentId: "A01" });
  const b = await f.approved({ instrumentId: "B01" });
  assert.equal((await f.upload(a, [event("a", 1, "1 a", undefined, "B01")])).status, 422);
  // A device id must match the credential that owns it.
  assert.equal((await f.request("/ingest/reports", { protocolVersion: 1, deviceId: b.deviceId, events: [event()] }, a.secret)).status, 403);
  assert.equal((await f.upload(a, [event("a1")])).status, 200);
  assert.equal((await f.upload(b, [event("b1", 1, "1 sample", undefined, "B01")])).status, 200);
  const result = await f.cloud.store.query(query);
  assert.equal(result.total, 2);
  assert.notEqual(result.reports[0].id, result.reports[1].id);
  assert.deepEqual(new Set(result.reports.map((report) => report.sourceId)), new Set([a.deviceId, b.deviceId]));
  assert.equal((await f.revoke(a.deviceId)).status, 200);
  assert.equal((await f.upload(a, [event("a2")])).status, 401);
  assert.equal((await f.cloud.store.query(query)).total, 2);
});

test("shift boundaries, aggregate export selection and repeatable frozen snapshots", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  const rows = [event("start", 1, "1 first", `${date}_07-00-00`), event("aggregate", 1, "1 总分析"), event("night", 1, "1 night", `${date}_19-00-00`), event("dawn", 1, "1 dawn", "2026-09-24_06-59-59"), event("tomorrow", 1, "1 tomorrow", "2026-09-24_07-00-00")];
  assert.equal((await f.upload(device, rows)).status, 200);
  assert.equal((await f.cloud.store.query(query)).total, 2);
  assert.equal((await f.cloud.store.query({ ...query, shift: "night" })).total, 2);
  assert.equal((await f.cloud.store.query({ ...query, shift: "full" })).total, 4);
  assert.equal((await f.cloud.store.query({ ...query, excludeAggregate: true })).total, 1);
  const frozen = await f.cloud.store.exportSnapshot(query);
  assert.equal(frozen.count, 1);
  const all = await f.cloud.store.exportSnapshot(query, { allSelected: true });
  assert.equal(all.count, 2);
  await assert.rejects(f.cloud.store.exportSnapshot(query), { status: 429 });
  assert.equal((await f.upload(device, [event("start", 2, "1 replaced", `${date}_07-00-00`)])).status, 200);
  assert.deepEqual((await collect(frozen)).map((report) => report.sampleName), ["1 first"]);
  assert.deepEqual((await collect(frozen)).map((report) => report.sampleName), ["1 first"]);
  const reader = all.reports[Symbol.asyncIterator]();
  await reader.next();
  await assert.rejects(all.reports[Symbol.asyncIterator]().next(), { status: 409 });
  await reader.return();
  await all.close();
  await frozen.close();
  await assert.rejects(collect(frozen), { status: 410 });
  const current = await f.cloud.store.query(query);
  const aggregate = current.reports.find((report) => report.isAggregate);
  const selected = await f.cloud.store.exportSnapshot(query, { ids: [aggregate.id] });
  assert.deepEqual((await collect(selected)).map((report) => report.id), [aggregate.id]);
  await selected.close();
  await assert.rejects(f.cloud.store.exportSnapshot(query, { ids: ["f".repeat(32)] }), { status: 409 });
  assert.equal((await f.cloud.store.query({ ...query, page: 2, pageSize: 1 })).reports[0].id, aggregate.id);
});

test("machine parser and event limits reject oversized deliveries without receipts", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  assert.equal((await f.upload(device, Array.from({ length: 33 }, (_, i) => event(`r-${i}`)))).status, 413);
  const large = event();
  large.report.operator = "x".repeat(1024 * 1024);
  large.contentHash = digest(large.report);
  assert.equal((await f.upload(device, [large])).status, 413);
  assert.equal((await f.request("/ingest/reports", { padding: "x".repeat(2 * 1024 * 1024) }, device.secret)).status, 413);
  assert.equal((await f.cloud.store.query(query)).total, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_receipts").get().n, 0);
});

test("full SQLite storage returns no acknowledgement and remains safely retryable", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  const delivery = event();
  delivery.report.testResults = Array.from({ length: 10000 }, (_, number) => ({ number, test: 1, gram: 3, mm: 0 }));
  delivery.contentHash = digest(delivery.report);
  const previousLimit = f.db.prepare("PRAGMA max_page_count").get().max_page_count;
  const pages = f.db.prepare("PRAGMA page_count").get().page_count;
  f.db.exec(`PRAGMA max_page_count=${pages}`);
  const failed = await f.upload(device, [delivery]);
  assert.equal(failed.status, 500);
  const failure = await failed.json();
  assert.equal(failure.acknowledgements, undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_receipts").get().n, 0);
  assert.equal((await f.cloud.store.query(query)).total, 0);
  f.db.exec(`PRAGMA max_page_count=${previousLimit}`);
  assert.equal((await f.upload(device, [delivery])).status, 200);
  assert.equal((await f.cloud.store.query(query)).reports[0].testResults[9999].number, 9999);
});

test("closing cloud storage closes active readers and denies subsequent ingestion", async (t) => {
  const f = await fixture(t);
  const device = await f.approved({ instrumentId: "A01" });
  assert.equal((await f.upload(device, [event()])).status, 200);
  const snapshot = await f.cloud.store.exportSnapshot(query);
  const reader = snapshot.reports[Symbol.asyncIterator]();
  await reader.next();
  await f.cloud.close();
  await assert.rejects(reader.next(), { status: 410 });
  await assert.rejects(f.cloud.store.query(query), { status: 503 });
  assert.equal((await f.upload(device, [event("after-close")])).status, 503);
  await snapshot.close();
});

test("3.0 旧设备行迁移为已批准并保留密钥", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-cloud-migrate-"));
  const legacy = new DatabaseSync(path.join(home, "lizi.sqlite"));
  legacy.exec(`CREATE TABLE cloud_devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, instrument_id TEXT NOT NULL,
    instrument_type TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    revoked INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, last_received_at TEXT,
    pending INTEGER, oldest_pending_at TEXT, last_error TEXT
  )`);
  const secret = secretValue();
  const id = randomUUID();
  legacy.prepare("INSERT INTO cloud_devices(id,name,instrument_id,instrument_type,token_hash) VALUES(?,?,?,?,?)").run(id, "旧设备", "A01", "strength", hash(secret));
  legacy.close();
  const db = openDatabase(home);
  const cloud = await createCloud({ home, db });
  t.after(async () => { await cloud.close(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  const view = cloud.store.device(id);
  assert.equal(view.registrationState, "approved");
  assert.equal(view.connectionState, "offline");
  assert.equal(view.location, null);
  assert.equal(view.clientVersion, null);
  assert.equal(view.pending, null);
  assert.equal(view.acquisitionError, null);
  assert.equal(db.prepare("SELECT token_hash FROM cloud_devices WHERE id=?").get(id).token_hash, hash(secret));
  // The kept secret still authenticates the migrated device.
  const listed = cloud.store.devices();
  assert.equal(listed.length, 1);
});
