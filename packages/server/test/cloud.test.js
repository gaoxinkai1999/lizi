import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { parseReport } from "@lizi/core";
import { openDatabase } from "../src/database.js";
import { createCloud } from "../src/cloud.js";

const date = "2026-09-23";
const query = { date, shift: "day" };
const digest = (report) => createHash("sha256").update(JSON.stringify(report)).digest("hex");
function event(reportId = "local-report", sequence = 1, sample = "1 sample", time = `${date}_08-00-00`) {
  const report = parseReport(`Date ${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 3\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 3 0\n`);
  report.id = reportId;
  return { eventId: randomUUID(), reportId, sequence, contentHash: digest(report), instrumentId: "strength-1", instrumentType: "strength", schemaVersion: 1, parserVersion: 2, occurredAt: "2026-09-23T08:00:00.000Z", historical: true, report };
}
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-cloud-"));
  let db, cloud, server, origin;
  async function start() {
    db = openDatabase(home);
    cloud = await createCloud({ home, db });
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
  async function register(id = randomUUID()) {
    const response = await request("/devices", { id, name: `device-${id}`, instrumentId: "strength-1", instrumentType: "strength" });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function upload(device, events, deviceId = device.device.id) {
    return request("/ingest/reports", { protocolVersion: 1, deviceId, events }, device.token);
  }
  return { get db() { return db; }, get cloud() { return cloud; }, request, register, upload, async restart() { await stop(); await start(); } };
}

async function collect(snapshot) {
  const rows = [];
  for await (const row of snapshot.reports) rows.push(row);
  return rows;
}

test("durable receipt replay after lost acknowledgement and restart preserves newest report", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
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
  const device = await f.register();
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

test("token-bound identity, rotation and revocation isolate devices without deleting reports", async (t) => {
  const f = await fixture(t);
  const a = await f.register();
  const b = await f.register();
  assert.equal((await f.upload(a, [event()], b.device.id)).status, 403);
  assert.equal((await f.upload(a, [event()])).status, 200);
  assert.equal((await f.upload(b, [event()])).status, 200);
  const result = await f.cloud.store.query(query);
  assert.equal(result.total, 2);
  assert.notEqual(result.reports[0].id, result.reports[1].id);
  assert.deepEqual(new Set(result.reports.map((report) => report.sourceId)), new Set([a.device.id, b.device.id]));
  assert.equal(result.reports[0].instrumentId, "strength-1");
  const listed = await (await f.request("/devices", undefined, undefined, "GET")).json();
  assert.equal(JSON.stringify(listed).includes(a.token), false);
  assert.equal(f.db.prepare("SELECT token_hash FROM cloud_devices WHERE id=?").get(a.device.id).token_hash, createHash("sha256").update(a.token).digest("hex"));
  const rotated = await (await f.request(`/devices/${a.device.id}/rotate`, {})).json();
  assert.equal((await f.upload(a, [event()])).status, 401);
  a.token = rotated.token;
  assert.equal((await f.upload(a, [event("rotated")])).status, 200);
  assert.equal((await f.request(`/devices/${a.device.id}`, undefined, undefined, "DELETE")).status, 200);
  assert.equal((await f.upload(a, [event()])).status, 401);
  assert.equal((await f.cloud.store.query(query)).total, 3);
  a.token = (await (await f.request(`/devices/${a.device.id}/rotate`, {})).json()).token;
  assert.equal((await f.upload(a, [event("reauthorized")])).status, 200);
});

test("shift boundaries, aggregate export selection and repeatable frozen snapshots", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
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

test("heartbeat backlog is visible but zero backlog never guarantees completeness", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  const heartbeat = { protocolVersion: 1, deviceId: device.device.id, pending: 12, oldestPendingAt: "2026-09-20T10:00:00.000Z", lastError: "连接暂不可用" };
  assert.equal((await f.request("/ingest/heartbeat", heartbeat, device.token)).status, 200);
  let result = await f.cloud.store.query(query);
  assert.equal(result.sources[0].pending, 12);
  assert.equal(result.sources[0].oldestPendingAt, heartbeat.oldestPendingAt);
  assert.equal(result.sources[0].state, "error");
  assert.equal((await f.request("/ingest/heartbeat", { ...heartbeat, pending: 0, oldestPendingAt: null, lastError: null }, device.token)).status, 200);
  result = await f.cloud.store.query(query);
  assert.equal(result.sources[0].state, "ready");
  assert.equal(result.sources[0].complete, false);
});

test("machine parser and event limits reject oversized deliveries without receipts", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
  assert.equal((await f.upload(device, Array.from({ length: 33 }, (_, i) => event(`r-${i}`)))).status, 413);
  const large = event();
  large.report.operator = "x".repeat(1024 * 1024);
  large.contentHash = digest(large.report);
  assert.equal((await f.upload(device, [large])).status, 413);
  assert.equal((await f.request("/ingest/reports", { padding: "x".repeat(2 * 1024 * 1024) }, device.token)).status, 413);
  assert.equal((await f.cloud.store.query(query)).total, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_receipts").get().n, 0);
});

test("full SQLite storage returns no acknowledgement and remains safely retryable", async (t) => {
  const f = await fixture(t);
  const device = await f.register();
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
  const device = await f.register();
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
