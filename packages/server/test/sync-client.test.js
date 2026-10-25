import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { parseReport } from "@lizi/core";
import { APP_VERSION, CENTER_URL } from "../../core/src/deployment.js";
import { openDatabase, getSetting, setSetting, transaction } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";
import { createSyncClient, normalizeServerUrl } from "../src/sync-client.js";
import { enqueueReport } from "../src/sync-outbox.js";

function today(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const text = (sample, date = today()) => `Date ${date}_07-00-00\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`;

async function until(predicate, message = "condition not reached") {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

function ack(body, events = body.events) {
  return { protocolVersion: 1, deviceId: body.deviceId,
    acknowledgements: events.map(({ eventId, reportId, sequence, contentHash }) => ({ eventId, reportId, sequence, contentHash })) };
}

function respond(response, body) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// Enrollment is a first-class ingest route; by default the center approves immediately.
async function serverFixture(t, reportHandler, heartbeatHandler, enrollHandler) {
  const enrolls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = JSON.parse(raw.toString()); } catch { body = null; }
    const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;
    if (request.url.endsWith("/enroll")) {
      enrolls.push({ body, auth });
      if (enrollHandler) return enrollHandler({ request, response, body, auth });
      respond(response, { protocolVersion: 1, deviceId: body?.deviceId, registrationState: "approved" });
      return;
    }
    if (request.url.endsWith("/heartbeat")) {
      if (heartbeatHandler) return heartbeatHandler({ request, response, body, auth });
      respond(response, {});
      return;
    }
    reportHandler({ request, response, body, bytes: raw.length });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, enrolls };
}

async function fixture(t, centerUrl, { realStore = false, configure = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-sync-"));
  const root = path.join(home, "reports");
  await fs.mkdir(root);
  let db = openDatabase(home);
  setSetting(db, "dataPath", root);
  const policy = await createDirectoryPolicy(home, JSON.stringify([root]));
  const deviceId = randomUUID();
  let store;
  let client;
  async function open() {
    store = realStore ? new ReportStore(db, policy) : Object.assign(new EventEmitter(), {
      syncConfigure: async () => {}, close: async () => {}, status: () => ({ errors: [] }), failure: null, root,
    });
    if (realStore) await store.start();
    client = await createSyncClient({ home, db, localStore: store,
      options: { centerUrl, allowLoopbackHttp: true, deviceId } });
  }
  await open();
  if (configure) await client.configure({ instrumentId: "A01", instrumentType: "strength" });
  t.after(async () => {
    await client.close();
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return {
    home, root, deviceId,
    get db() { return db; }, get store() { return store; }, get client() { return client; },
    enqueue(id, sample, historical = false) {
      transaction(db, () => enqueueReport(db, id, JSON.stringify(parseReport(text(sample))), historical));
    },
    async restart() {
      await client.close();
      await store.close();
      db.close();
      db = openDatabase(home);
      await open();
    },
  };
}

async function stableWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const older = new Date(Date.now() - 10000);
  await fs.utimes(file, older, older);
}

test("URL policy rejects insecure endpoints and credentials, normalizes duplicate slashes", () => {
  assert.equal(normalizeServerUrl("https://EXAMPLE.com//base///"), "https://example.com/base");
  for (const url of ["http://example.com", "http://127.0.0.1", "https://a/#", "https://a/?", "https://user:pass@a", "ftp://a"])
    assert.throws(() => normalizeServerUrl(url), { status: 400 });
  assert.equal(normalizeServerUrl("http://127.0.0.1:1234/", true), "http://127.0.0.1:1234");
});

test("saving type and short ID enrolls automatically; approval uploads with no manual token", async (t) => {
  const batches = [];
  let enrollState = "pending";
  const { url, enrolls } = await serverFixture(t,
    ({ response, body }) => { batches.push(body); respond(response, ack(body)); },
    undefined,
    ({ response, body }) => response.writeHead(202, { "content-type": "application/json" })
      .end(JSON.stringify({ protocolVersion: 1, deviceId: body.deviceId, registrationState: enrollState })));
  const f = await fixture(t, url);
  const settings = f.client.getSettings();
  assert.deepEqual(Object.keys(settings).sort(), ["centerUrl", "configured", "identityLocked", "instrumentId", "instrumentType"]);
  assert.equal(settings.instrumentId, "A01");
  assert.equal(settings.instrumentType, "strength");
  assert.equal(settings.configured, true);
  assert.equal(settings.identityLocked, false);
  assert.equal(settings.centerUrl, url);
  const saved = JSON.parse(await fs.readFile(path.join(f.home, "sync-credentials.json"), "utf8"));
  assert.match(saved.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.deviceId, f.deviceId);
  assert.equal(saved.centerUrl, url);
  f.enqueue("a", "one");
  await f.client.start();
  await until(() => f.client.getStatus().registrationState === "pending" && enrolls.length >= 1);
  assert.equal(batches.length, 0);
  assert.equal(f.client.getStatus().pending, 1);
  assert.match(enrolls[0].auth, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(enrolls[0].body, { protocolVersion: 1, deviceId: f.deviceId, instrumentId: "A01",
    instrumentType: "strength", clientVersion: APP_VERSION });
  enrollState = "approved";
  await f.client.retry();
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(batches[0].deviceId, f.deviceId);
  // The device secret that enrolled is the same one that authenticates uploads.
  assert.ok(enrolls.every((entry) => entry.auth === enrolls[0].auth));
});

test("legacy URL/token/enable/device inputs and unknown instrument types are rejected", async (t) => {
  const { url } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url);
  for (const input of [{ serverUrl: "https://x.example" }, { token: "x" }, { enabled: true }, { deviceId: randomUUID() }])
    await assert.rejects(f.client.configure(input), { status: 400 });
  await assert.rejects(f.client.configure({ instrumentType: "imaginary" }), { status: 400 });
  await assert.rejects(f.client.configure({ instrumentId: "no spaces!" }), { status: 400 });
  await assert.rejects(f.client.configure({ instrumentId: "" }), { status: 400 });
});

test("instrument identity locks after events are generated", async (t) => {
  const { url } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await assert.rejects(f.client.configure({ instrumentId: "B02" }), { status: 409 });
  assert.equal(f.client.getSettings().instrumentId, "A01");
  assert.equal(f.client.getSettings().identityLocked, true);
});

test("lost response replays durable identical event after restart and exact acknowledgement drains", async (t) => {
  const requests = [];
  let acknowledge = false;
  const { url } = await serverFixture(t, ({ request, response, body }) => {
    requests.push(body);
    if (!acknowledge) request.socket.destroy();
    else respond(response, ack(body));
  });
  const f = await fixture(t, url);
  f.enqueue("report-a", "first");
  const original = f.db.prepare("SELECT * FROM sync_outbox").get();
  await f.client.start();
  await until(() => f.client.getStatus().nextAttemptAt);
  const nextAttemptAt = f.client.getStatus().nextAttemptAt;
  await f.restart();
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(f.client.getStatus().oldestPendingAt, original.created_at);
  assert.equal(f.client.getStatus().nextAttemptAt, nextAttemptAt);
  acknowledge = true;
  await f.client.start();
  await f.client.retry();
  await until(() => f.client.getStatus().pending === 0);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].events[0].eventId, original.event_id);
  assert.equal(requests[0].events[0].contentHash, createHash("sha256").update(JSON.stringify(requests[0].events[0].report)).digest("hex"));
  assert.ok(f.client.getStatus().lastSuccessAt);
});

test("new revision during inflight and malformed acknowledgement cannot delete another event", async (t) => {
  let held;
  const { url } = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("report-a", "first");
  await f.client.start();
  await until(() => held);
  f.enqueue("report-a", "second");
  const newest = f.db.prepare("SELECT * FROM sync_outbox WHERE sequence=2").get();
  respond(held.response, ack(held.body));
  await until(() => f.client.getStatus().pending === 1);
  assert.equal(f.db.prepare("SELECT event_id FROM sync_outbox").get().event_id, newest.event_id);
  held = null;
  await f.client.retry();
  await until(() => held);
  const bad = ack(held.body);
  bad.acknowledgements[0].contentHash = "0".repeat(64);
  respond(held.response, bad);
  await until(() => f.client.getStatus().nextAttemptAt);
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(f.db.prepare("SELECT event_id FROM sync_outbox").get().event_id, newest.event_id);
});

test("partial exact acknowledgements remove only committed events; wrong device and duplicates remove none", async (t) => {
  let held;
  const { url } = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("a", "one"); f.enqueue("b", "two");
  await f.client.start();
  await until(() => held);
  respond(held.response, ack(held.body, [held.body.events[0]]));
  await until(() => f.client.getStatus().pending === 1 && f.client.getStatus().nextAttemptAt);
  for (const corrupt of [
    (body) => ({ ...ack(body), deviceId: randomUUID() }),
    (body) => ({ ...ack(body), acknowledgements: [...ack(body).acknowledgements, ...ack(body).acknowledgements] }),
    () => ({}),
  ]) {
    held = null;
    await f.client.retry();
    await until(() => held);
    respond(held.response, corrupt(held.body));
    await until(() => f.client.getStatus().nextAttemptAt);
    assert.equal(f.client.getStatus().pending, 1);
  }
});

test("revoked devices keep their queue and resume with the same credential after re-approval", async (t) => {
  const batches = [];
  let enrollState = "approved";
  const { url, enrolls } = await serverFixture(t, ({ request, response, body }) => {
    if (enrollState === "revoked") { response.writeHead(401).end(); return; }
    batches.push(body);
    respond(response, ack(body));
  }, undefined, ({ response, body }) => respond(response,
    { protocolVersion: 1, deviceId: body.deviceId, registrationState: enrollState }));
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
  const secret = enrolls[0].auth;
  enrollState = "revoked";
  f.enqueue("b", "two");
  await f.client.retry();
  await until(() => f.client.getStatus().registrationState === "revoked");
  assert.equal(f.client.getStatus().pending, 1);
  const delivered = batches.length;
  await f.client.retry();
  await delay(120);
  assert.equal(f.client.getStatus().registrationState, "revoked");
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(batches.length, delivered);
  enrollState = "approved";
  await f.client.retry();
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(f.client.getStatus().registrationState, "approved");
  assert.ok(enrolls.every((entry) => entry.auth === secret));
});

test("authorization failure from enrollment is a visible permanent error that preserves the queue", async (t) => {
  const batches = [];
  const { url } = await serverFixture(t,
    ({ response, body }) => { batches.push(body); respond(response, ack(body)); },
    undefined, ({ response }) => response.writeHead(401).end());
  const f = await fixture(t, url);
  f.enqueue("a", "retained");
  await f.client.start();
  await until(() => f.client.getStatus().paused && /重新登记/.test(f.client.getStatus().lastError ?? ""));
  assert.equal(f.client.getStatus().pending, 1);
  await f.restart();
  await f.client.start();
  await delay(120);
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(batches.length, 0);
});

test("a duplicate short ID stays retryable and keeps the queue instead of stopping", async (t) => {
  let calls = 0;
  const { url } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)),
    undefined, ({ response }) => { calls += 1; response.writeHead(409).end(); });
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await f.client.start();
  await until(() => calls >= 1 && /编号/.test(f.client.getStatus().lastError ?? ""));
  assert.equal(f.client.getStatus().paused, false);
  assert.equal(f.client.getStatus().registrationState, "pending");
  assert.equal(f.client.getStatus().pending, 1);
  await f.client.retry();
  await until(() => calls >= 2);
});

test("legacy fixed endpoint with pending reports is refused and never retargeted", async (t) => {
  const batches = [];
  const { url, enrolls } = await serverFixture(t, ({ response, body }) => { batches.push(body); respond(response, ack(body)); });
  const f = await fixture(t, url);
  await f.client.close();
  f.enqueue("late", "late");
  setSetting(f.db, "syncConfig", JSON.stringify({ enabled: true, serverUrl: "https://old.example", deviceId: f.deviceId,
    token: "legacy-token", instrumentId: "A01", instrumentType: "strength", configured: true }));
  await fs.writeFile(path.join(f.home, "sync-credentials.json"),
    JSON.stringify({ serverUrl: "https://old.example", deviceId: f.deviceId, token: "legacy-token" }));
  await f.restart();
  assert.equal(f.client.getSettings().configured, true);
  await f.client.start();
  await delay(150);
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(batches.length, 0);
  assert.equal(enrolls.length, 0);
  // The refusal must survive repeated restarts, not only the process that detected it.
  await f.restart();
  await f.client.start();
  await delay(150);
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(f.client.getStatus().pending, 1);
  assert.equal(batches.length, 0);
  assert.equal(enrolls.length, 0);
  await assert.rejects(f.client.configure({ instrumentId: "A01", instrumentType: "strength" }), { status: 409 });
  await delay(80);
  assert.equal(batches.length, 0);
  assert.equal(f.client.getStatus().pending, 1);
  const credentials = JSON.parse(await fs.readFile(path.join(f.home, "sync-credentials.json"), "utf8"));
  assert.equal(credentials.secret, undefined);
});

test("3.0 token credentials aimed at the fixed center are reused as the device secret", async (t) => {
  const { url, enrolls } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url, { configure: false });
  const token = "T".repeat(43);
  setSetting(f.db, "syncConfig", JSON.stringify({ enabled: true, serverUrl: CENTER_URL, deviceId: f.deviceId,
    token, instrumentId: "", instrumentType: "strength", configured: false }));
  await fs.writeFile(path.join(f.home, "sync-credentials.json"),
    JSON.stringify({ serverUrl: CENTER_URL, deviceId: f.deviceId, token }));
  await f.restart();
  await f.client.configure({ instrumentId: "A01", instrumentType: "strength" });
  await f.client.start();
  await until(() => enrolls.length >= 1);
  assert.equal(enrolls[0].auth, token);
  const credentials = JSON.parse(await fs.readFile(path.join(f.home, "sync-credentials.json"), "utf8"));
  assert.equal(credentials.secret, token);
  assert.equal(credentials.centerUrl, url);
});

test("legacy endpoint migration re-baselines only after the queue is drained", async (t) => {
  const received = [];
  const { url } = await serverFixture(t, ({ response, body }) => { received.push(...body.events); respond(response, ack(body)); });
  const f = await fixture(t, url, { realStore: true });
  const file = path.join(f.root, today(), "instrument", "existing.txt");
  await stableWrite(file, text("existing"));
  await until(() => f.db.prepare("SELECT id FROM reports WHERE path=?").get(file));
  await until(() => f.client.getStatus().pending === 1);
  const baseline = JSON.parse(f.db.prepare("SELECT payload FROM sync_outbox").get().payload);
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
  await f.client.close();
  setSetting(f.db, "syncConfig", JSON.stringify({ enabled: true, serverUrl: "https://old.example", deviceId: f.deviceId,
    token: "legacy-token", instrumentId: "A01", instrumentType: "strength", configured: true }));
  await f.restart();
  await f.client.start();
  await until(() => received.some((event) => event.reportId === baseline.reportId && event.sequence === baseline.sequence + 1));
  const replacement = received.find((event) => event.reportId === baseline.reportId && event.sequence === baseline.sequence + 1);
  assert.equal(replacement.contentHash, baseline.contentHash);
  assert.notEqual(replacement.eventId, baseline.eventId);
  assert.equal(received[0].reportId, baseline.reportId);
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(f.client.getStatus().lastError, null);
});

test("large offline backlog sends bounded batches and shutdown cancels a stalled request", async (t) => {
  const batches = [];
  let hold = true;
  let held;
  const { url } = await serverFixture(t, (request) => {
    batches.push(request);
    if (hold) held = request;
    else respond(request.response, ack(request.body));
  });
  const f = await fixture(t, url);
  for (let index = 0; index < 80; index += 1) f.enqueue(`report-${index}`, `${index}-${"x".repeat(70000)}`);
  await f.client.start();
  await until(() => held);
  const beforeClose = Date.now();
  await f.client.close();
  assert.ok(Date.now() - beforeClose < 2000, "shutdown must abort rather than wait for the network timeout");
  await f.restart();
  assert.equal(f.client.getStatus().pending, 80);
  hold = false;
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
  assert.ok(batches.length >= 3);
  for (const batch of batches) {
    assert.ok(batch.body.events.length <= 32);
    assert.ok(batch.bytes <= 2 * 1024 * 1024);
  }
});

test("background acquisition without browser queries catches downtime and preserves deleted source payloads", async (t) => {
  const { url } = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, { realStore: true });
  await f.client.start();
  const first = path.join(f.root, today(), "instrument", "first.txt");
  await stableWrite(first, text("first"));
  await until(() => f.client.getStatus().pending === 1, "worker should enqueue without a query");
  const original = f.db.prepare("SELECT event_id,payload FROM sync_outbox").get();
  await fs.unlink(first);
  await f.store.scan();
  assert.deepEqual({ ...f.db.prepare("SELECT event_id,payload FROM sync_outbox").get() }, { ...original });
  const key = `acquisition:${createHash("sha256").update(f.root).digest("hex")}`;
  await f.client.close();
  await f.store.close();
  setSetting(f.db, key, today(-8));
  for (let day = -7; day <= 0; day += 1)
    await stableWrite(path.join(f.root, today(day), "instrument", "offline.txt"), text(`offline-${day}`, today(day)));
  await f.restart();
  await f.client.start();
  await until(() => f.client.getStatus().pending === 9 && getSetting(f.db, key) === today(),
    "all days beyond active scope limit must finish their contiguous checkpoint");
  assert.equal(getSetting(f.db, key), today());
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM reports").get().count, 8);
  assert.equal(f.client.getSettings().configured, true);
});

test("offline enrollment keeps local acquisition working and separates registration from upload errors", async (t) => {
  let online = false;
  const { url, enrolls } = await serverFixture(t,
    ({ request, response, body }) => { if (!online) request.socket.destroy(); else respond(response, ack(body)); },
    undefined,
    ({ request, response, body }) => {
      if (!online) { request.socket.destroy(); return; }
      respond(response, { protocolVersion: 1, deviceId: body.deviceId, registrationState: "approved" });
    });
  const f = await fixture(t, url, { realStore: true });
  await f.client.start();
  const file = path.join(f.root, today(), "instrument", "offline.txt");
  await stableWrite(file, text("offline"));
  await until(() => f.client.getStatus().pending === 1);
  const status = f.client.getStatus();
  assert.equal(status.registrationState, "pending");
  assert.equal(status.paused, false);
  assert.equal(status.acquisitionError, null);
  assert.match(status.lastError, /网络不可用|登记/);
  assert.ok(f.db.prepare("SELECT id FROM reports WHERE path=?").get(file));
  assert.ok(enrolls.length >= 1);
  online = true;
  await f.client.retry();
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(f.client.getStatus().registrationState, "approved");
});

test("queue storage failure rolls back report fingerprint; repaired disk and modified malformed files retry", async (t) => {
  const { url } = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, { realStore: true });
  await f.client.start();
  f.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;");
  const file = path.join(f.root, today(), "instrument", "disk.txt");
  await stableWrite(file, text("disk"));
  await until(() => f.store.status().errors.some((error) => /disk unavailable/.test(error.message)));
  assert.equal(f.db.prepare("SELECT id FROM reports WHERE path=?").get(file), undefined);
  assert.equal(f.db.prepare("SELECT fingerprint FROM report_files WHERE path=?").get(file), undefined);
  assert.match(f.client.getStatus().acquisitionError, /disk unavailable/);
  f.db.exec("DROP TRIGGER reject_outbox");
  await f.store.scan();
  await until(() => f.client.getStatus().pending === 1);
  const malformed = path.join(f.root, today(), "instrument", "partial.txt");
  await stableWrite(malformed, "half-written");
  await f.store.scan();
  assert.equal(f.db.prepare("SELECT id FROM reports WHERE path=?").get(malformed), undefined);
  await stableWrite(malformed, text("repaired"));
  await f.store.scan();
  await until(() => f.client.getStatus().pending === 2);
});

test("failed heartbeat cannot block uploads and carries clientVersion with a separate acquisitionError", async (t) => {
  let heartbeatFails = true;
  let uploadFails = false;
  const heartbeats = [];
  const { url } = await serverFixture(t, ({ request, response, body }) => {
    if (uploadFails) request.socket.destroy();
    else respond(response, ack(body));
  }, ({ request, response, body }) => {
    heartbeats.push(body);
    if (heartbeatFails) request.socket.destroy();
    else respond(response, {});
  });
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0 && heartbeats.length >= 1);
  heartbeatFails = false;
  uploadFails = true;
  f.enqueue("b", "two");
  await f.client.retry();
  await until(() => heartbeats.length >= 2 && f.client.getStatus().nextAttemptAt);
  assert.equal(f.client.getStatus().pending, 1);
  assert.match(f.client.getStatus().lastError, /网络/);
  assert.equal(heartbeats[0].clientVersion, APP_VERSION);
  assert.ok("acquisitionError" in heartbeats[0]);
  assert.equal(heartbeats[0].acquisitionError, null);
});

test("explicit historical date range survives restart and marks historical reports without a query", async (t) => {
  const { url } = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, { realStore: true });
  await f.client.start();
  const from = "2020-01-01";
  const to = "2020-01-03";
  await assert.rejects(f.client.backfill({ from: "2020-02-30", to }), { status: 400 });
  await assert.rejects(f.client.backfill({ from: to, to: from }), { status: 400 });
  await assert.rejects(f.client.backfill({ from: "2000-01-01", to: "2020-01-01" }), { status: 400 });
  await f.store.close();
  for (const date of [from, "2020-01-02", to])
    await stableWrite(path.join(f.root, date, "instrument", "history.txt"), text(date, date));
  await f.restart();
  const scheduled = await f.client.backfill({ from, to });
  assert.equal(scheduled.scheduled, 3);
  await f.restart();
  await f.client.start();
  await until(() => f.client.getStatus().pending === 3 && f.client.getStatus().backfillPendingDays === 0);
  const events = f.db.prepare("SELECT payload FROM sync_outbox").all().map((row) => JSON.parse(row.payload));
  assert.deepEqual(events.map((event) => event.report.date).sort(), [from, "2020-01-02", to]);
  assert.ok(events.every((event) => event.historical));
  assert.equal(f.client.getSettings().configured, true);
});

test("missing or mismatched credentials remain visibly paused until repaired", async (t) => {
  const { url } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url);
  f.enqueue("a", "retained");
  await fs.unlink(path.join(f.home, "sync-credentials.json"));
  await f.restart();
  assert.equal(f.client.getSettings().configured, true);
  assert.equal(f.client.getStatus().paused, true);
  assert.match(f.client.getStatus().lastError, /凭据/);
  await f.client.start();
  await f.client.retry();
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(f.client.getStatus().pending, 1);
  await fs.writeFile(path.join(f.home, "sync-credentials.json"), JSON.stringify({
    secret: "A".repeat(43), deviceId: f.deviceId, centerUrl: "https://another.example",
  }));
  await f.restart();
  assert.equal(f.client.getStatus().paused, true);
  assert.match(f.client.getStatus().lastError, /凭据/);
  await f.client.configure({ instrumentId: "A01", instrumentType: "strength" });
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(f.client.getStatus().registrationState, "approved");
});

test("an unconfigured client registers nothing until instrument type and ID are saved", async (t) => {
  const { url, enrolls } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url, { configure: false });
  await f.client.start();
  await delay(120);
  assert.equal(f.client.getSettings().configured, false);
  assert.equal(f.client.getStatus().registrationState, "unconfigured");
  assert.equal(enrolls.length, 0);
  await f.client.configure({ instrumentId: "A01", instrumentType: "strength" });
  await until(() => enrolls.length >= 1);
  assert.equal(f.client.getStatus().registrationState, "approved");
});

test("configured clients without a report directory surface it through acquisitionError", async (t) => {
  const heartbeats = [];
  const { url } = await serverFixture(t, ({ response, body }) => respond(response, ack(body)),
    ({ response, body }) => { heartbeats.push(body); respond(response, {}); });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-sync-"));
  const db = openDatabase(home);
  const store = Object.assign(new EventEmitter(), {
    syncConfigure: async () => {}, close: async () => {}, status: () => ({ errors: [] }), failure: null, root: "",
  });
  const deviceId = randomUUID();
  const client = await createSyncClient({ home, db, localStore: store,
    options: { centerUrl: url, allowLoopbackHttp: true, deviceId } });
  t.after(async () => { await client.close(); db.close(); await fs.rm(home, { recursive: true, force: true }); });
  await client.configure({ instrumentId: "A01", instrumentType: "strength" });
  assert.equal(client.getStatus().acquisitionError, "尚未设置报告目录");
  await client.start();
  await until(() => heartbeats.length >= 1);
  assert.equal(heartbeats[0].acquisitionError, "尚未设置报告目录");
});

test("ACK persistence and metric read failures retain event and recover without rejecting background work", async (t) => {
  let held;
  const { url } = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("a", "durable");
  await f.client.start();
  await until(() => held);
  assert.equal(f.client.getStatus().pending, 1);
  let unavailable = true;
  const realDatabase = f.db;
  f.client.db = {
    exec(sql) { return realDatabase.exec(sql); },
    prepare(sql) {
      if (unavailable) throw new Error("simulated storage I/O failure");
      return realDatabase.prepare(sql);
    },
  };
  const eventId = held.body.events[0].eventId;
  respond(held.response, ack(held.body));
  await until(() => !f.client.flight);
  const failed = f.client.getStatus();
  assert.equal(failed.pending, 1);
  assert.equal(failed.queueMetricsStale, true);
  assert.equal(failed.paused, true);
  assert.match(failed.lastError, /队列读取失败/);
  assert.equal(realDatabase.prepare("SELECT event_id FROM sync_outbox").get().event_id, eventId);
  f.client.heartbeat();
  f.store.emit("status", { errors: [{ message: "acquisition failed" }] });
  unavailable = false;
  held = null;
  await f.client.retry();
  await until(() => held);
  assert.equal(held.body.events[0].eventId, eventId);
  respond(held.response, ack(held.body));
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(f.client.getStatus().queueMetricsStale, false);
});

test("heartbeat edits are applied to the local report and uploaded as a new version", async (t) => {
  const acks = [];
  const batches = [];
  const pending = [];
  const { url } = await serverFixture(t,
    ({ request, response, body }) => {
      if (request.url.endsWith("/edits/ack")) {
        acks.push(body);
        respond(response, { protocolVersion: 1, deviceId: body.deviceId, accepted: body.results.length });
        return;
      }
      batches.push(body);
      respond(response, ack(body));
    },
    ({ response, body }) => respond(response, { protocolVersion: 1, deviceId: body.deviceId, registrationState: "approved", edits: pending.slice() }));
  const f = await fixture(t, url, { realStore: true });
  await f.client.start();
  await stableWrite(path.join(f.root, today(), "instrument", "edit.txt"), text("原始样品"));
  await f.store.scan();
  const row = f.db.prepare("SELECT id FROM reports").get();
  assert.ok(row, "扫描后本地应有一份报告");

  pending.push({ id: 11, reportId: row.id, edit: { sampleName: "更正后" } });
  await until(() => { f.client.heartbeat(); return acks.length === 1; }, "edit should be acknowledged");
  assert.deepEqual(acks[0].results, [{ id: 11, ok: true }]);
  assert.equal(JSON.parse(f.db.prepare("SELECT json FROM reports WHERE id=?").get(row.id).json).sampleName, "更正后");
  await until(() => batches.some((batch) => (batch.events || []).some((event) => event.report.sampleName === "更正后")), "edited report should be uploaded");
  const uploaded = batches.flatMap((batch) => batch.events).filter((event) => event.report.sampleName === "更正后");
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].sequence, 2);

  // 回执丢失时中心会重发同一条：再次应用 changed=false，不会多出版本。
  await until(() => { f.client.heartbeat(); return acks.length === 2; }, "repeated edit should be acknowledged again");
  assert.deepEqual(acks[1].results, [{ id: 11, ok: true }]);
  await delay(50);
  assert.equal(batches.flatMap((batch) => batch.events).filter((event) => event.report.sampleName === "更正后").length, 1);
});
