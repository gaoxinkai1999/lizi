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

async function serverFixture(t, handler, heartbeatHandler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    if (request.url.endsWith("/heartbeat")) {
      if (heartbeatHandler) return heartbeatHandler({ request, response, body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    handler({ request, response, body, bytes: raw.length });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, serverUrl, realStore = false, configure = true) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-sync-"));
  const root = path.join(home, "reports");
  await fs.mkdir(root);
  let db = openDatabase(home);
  setSetting(db, "dataPath", root);
  const policy = await createDirectoryPolicy(home, JSON.stringify([root]));
  let store;
  let client;
  const deviceId = randomUUID();
  async function open() {
    store = realStore ? new ReportStore(db, policy) : Object.assign(new EventEmitter(), {
      syncConfigure: async () => {}, close: async () => {}, status: () => ({ errors: [] }),
    });
    if (realStore) await store.start();
    client = await createSyncClient({ home, db, localStore: store, options: { allowLoopbackHttp: true, deviceId } });
  }
  await open();
  if (configure)
    await client.configure({ enabled: false, serverUrl, token: "device-secret", instrumentId: "strength-1", instrumentType: "strength" });
  t.after(async () => {
    await client.close();
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return {
    home, root, deviceId,
    get db() { return db; }, get store() { return store; }, get client() { return client; },
    enqueue(id, sample) {
      transaction(db, () => enqueueReport(db, id, JSON.stringify(parseReport(text(sample)))));
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

function respond(response, body) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

test("URL policy rejects insecure endpoints and credentials, normalizes duplicate slashes", () => {
  assert.equal(normalizeServerUrl("https://EXAMPLE.com//base///"), "https://example.com/base");
  for (const url of ["http://example.com", "http://127.0.0.1", "https://a/#", "https://a/?", "https://user:pass@a", "ftp://a"])
    assert.throws(() => normalizeServerUrl(url), { status: 400 });
  assert.equal(normalizeServerUrl("http://127.0.0.1:1234/", true), "http://127.0.0.1:1234");
});

test("lost response replays durable identical event after restart and exact acknowledgement drains", async (t) => {
  const requests = [];
  let acknowledge = false;
  const url = await serverFixture(t, ({ request, response, body }) => {
    requests.push(body);
    if (!acknowledge) request.socket.destroy();
    else respond(response, ack(body));
  });
  const f = await fixture(t, url);
  f.enqueue("report-a", "first");
  const original = f.db.prepare("SELECT * FROM sync_outbox").get();
  await f.client.configure({ enabled: true });
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
  const url = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("report-a", "first");
  await f.client.configure({ enabled: true });
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
  const url = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("a", "one"); f.enqueue("b", "two");
  await f.client.configure({ enabled: true });
  await f.client.start();
  await until(() => held);
  const response = ack(held.body, [held.body.events[0]]);
  respond(held.response, response);
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

test("authorization errors pause durably; disabled queue and endpoint/identity changes are safe", async (t) => {
  let accepted = false;
  let calls = 0;
  const url = await serverFixture(t, ({ response, body }) => {
    calls += 1;
    if (accepted) respond(response, ack(body));
    else response.writeHead(401).end();
  });
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await assert.rejects(f.client.configure({ serverUrl: "https://another.example" }), { status: 409 });
  await assert.rejects(f.client.configure({ instrumentId: "changed" }), { status: 409 });
  await assert.rejects(f.client.configure({ instrumentType: "imaginary" }), { status: 400 });
  await f.client.configure({ enabled: true });
  await f.client.start();
  await until(() => f.client.getStatus().paused);
  assert.match(f.client.getStatus().lastError, /令牌/);
  await f.restart();
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(calls, 1);
  await f.client.configure({ enabled: false });
  f.enqueue("b", "while-disabled");
  await f.client.start();
  assert.equal(f.client.getStatus().pending, 2);
  assert.equal(calls, 1);
  accepted = true;
  await f.client.configure({ enabled: true, token: "rotated-token" });
  await until(() => f.client.getStatus().pending === 0);
  assert.equal(JSON.stringify(f.client.getSettings()).includes("rotated-token"), false);
  await f.client.configure({ serverUrl: "https://another.example", token: "new-token", enabled: false });
  assert.equal(f.client.getSettings().serverUrl, "https://another.example");
});

test("large offline backlog sends bounded batches and shutdown cancels a stalled request", async (t) => {
  const batches = [];
  let hold = true;
  let held;
  const url = await serverFixture(t, (request) => {
    batches.push(request);
    if (hold) held = request;
    else respond(request.response, ack(request.body));
  });
  const f = await fixture(t, url);
  for (let index = 0; index < 80; index += 1) f.enqueue(`report-${index}`, `${index}-${"x".repeat(70000)}`);
  await f.client.configure({ enabled: true });
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
  assert.ok(batches.length >= 4);
  for (const batch of batches) {
    assert.ok(batch.body.events.length <= 32);
    assert.ok(batch.bytes <= 2 * 1024 * 1024);
  }
});

test("background acquisition without browser queries catches downtime and preserves deleted source payloads", async (t) => {
  const url = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, true);
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
  assert.equal(f.client.getSettings().enabled, false);
});

test("queue storage failure rolls back report fingerprint; repaired disk and modified malformed files retry", async (t) => {
  const url = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, true);
  await f.client.start();
  f.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;");
  const file = path.join(f.root, today(), "instrument", "disk.txt");
  await stableWrite(file, text("disk"));
  await until(() => f.store.status().errors.some((error) => error.message.includes("disk unavailable")));
  assert.equal(f.db.prepare("SELECT id FROM reports WHERE path=?").get(file), undefined);
  assert.equal(f.db.prepare("SELECT fingerprint FROM report_files WHERE path=?").get(file), undefined);
  assert.match(f.client.getStatus().lastError, /采集/);
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

test("failed heartbeat cannot block uploads and successful heartbeat cannot discard a failed upload", async (t) => {
  let heartbeatFails = true;
  let uploadFails = false;
  let heartbeats = 0;
  const url = await serverFixture(t, ({ request, response, body }) => {
    if (uploadFails) request.socket.destroy();
    else respond(response, ack(body));
  }, ({ request, response }) => {
    heartbeats += 1;
    if (heartbeatFails) request.socket.destroy();
    else respond(response, {});
  });
  const f = await fixture(t, url);
  f.enqueue("a", "one");
  await f.client.configure({ enabled: true });
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0 && heartbeats === 1);
  heartbeatFails = false;
  uploadFails = true;
  f.enqueue("b", "two");
  await f.client.retry();
  await until(() => heartbeats === 2 && f.client.getStatus().nextAttemptAt);
  assert.equal(f.client.getStatus().pending, 1);
  assert.match(f.client.getStatus().lastError, /网络/);
});

test("explicit historical date range survives restart and marks historical reports without a query", async (t) => {
  const url = await serverFixture(t, ({ request }) => request.socket.destroy());
  const f = await fixture(t, url, true);
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
  assert.equal(f.client.getSettings().enabled, false);
});

test("already parsed local records become historical baseline and drained endpoint switch re-baselines without resetting sequence", async (t) => {
  const received = [];
  const url = await serverFixture(t, ({ response, body }) => { received.push(...body.events); respond(response, ack(body)); });
  const f = await fixture(t, url, true, false);
  const file = path.join(f.root, today(), "instrument", "existing.txt");
  await stableWrite(file, text("before-configuration"));
  await until(() => f.db.prepare("SELECT id FROM reports WHERE path=?").get(file));
  assert.equal(f.client.getStatus().pending, 0);
  await f.client.configure({ enabled: false, serverUrl: url, token: "device-secret", instrumentId: "strength-1" });
  await until(() => f.client.getStatus().pending === 1);
  const baseline = JSON.parse(f.db.prepare("SELECT payload FROM sync_outbox").get().payload);
  assert.equal(baseline.historical, true);
  await f.client.configure({ enabled: true });
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
  await f.client.configure({ enabled: false, serverUrl: `${url}/another-server`, token: "new-token" });
  await until(() => f.client.getStatus().pending === 1);
  const replacement = JSON.parse(f.db.prepare("SELECT payload FROM sync_outbox").get().payload);
  assert.equal(replacement.sequence, baseline.sequence + 1);
  assert.equal(replacement.contentHash, baseline.contentHash);
  assert.notEqual(replacement.eventId, baseline.eventId);
  assert.equal(received[0].reportId, baseline.reportId);
});

test("missing or mismatched credentials remain visibly paused until repaired", async (t) => {
  const url = await serverFixture(t, ({ response, body }) => respond(response, ack(body)));
  const f = await fixture(t, url);
  f.enqueue("a", "retained");
  await f.client.configure({ enabled: true });
  await fs.unlink(path.join(f.home, "sync-credentials.json"));
  await f.restart();
  assert.equal(f.client.getSettings().tokenConfigured, false);
  assert.equal(f.client.getStatus().paused, true);
  assert.match(f.client.getStatus().lastError, /凭据缺失/);
  await f.client.start();
  await f.client.retry();
  assert.equal(f.client.getStatus().paused, true);
  assert.equal(f.client.getStatus().pending, 1);
  await fs.writeFile(path.join(f.home, "sync-credentials.json"), JSON.stringify({
    token: "wrong-target-secret", deviceId: f.deviceId, serverUrl: "https://another.example",
  }));
  await f.restart();
  assert.equal(f.client.getSettings().tokenConfigured, false);
  assert.equal(f.client.getStatus().paused, true);
  await f.client.configure({ token: "repaired-secret" });
  await f.client.start();
  await until(() => f.client.getStatus().pending === 0);
});

test("ACK persistence and metric read failures retain event and recover without rejecting background work", async (t) => {
  let held;
  const url = await serverFixture(t, (request) => { held = request; });
  const f = await fixture(t, url);
  f.enqueue("a", "durable");
  await f.client.configure({ enabled: true });
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
