import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import dgram from "node:dgram";
import { createLanManager } from "../src/lan.js";
import { requestJson } from "../src/lan-protocol.js";
import { openDatabase } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";

const query = { date: "2026-09-23", shift: "day", excludeAggregate: false };
const lanOptions = {
  port: 0,
  discovery: false,
  bindAddress: "127.0.0.1",
  allowLoopback: true,
};

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-lan-"));
  const root = path.join(home, "reports");
  await fs.mkdir(root);
  const directories = await createDirectoryPolicy(home, JSON.stringify([root]));
  const db = openDatabase(home);
  const store = new ReportStore(db, directories);
  await store.start();
  await store.setRoot(root);
  const managers = [];
  async function manager(options = {}) {
    const lan = await createLanManager({
      home,
      store,
      options: { ...lanOptions, ...options },
    });
    managers.push(lan);
    return lan;
  }
  t.after(async () => {
    for (const lan of managers) await lan.close();
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, root, store, manager };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function pair(host, collector) {
  await collector.configure({ mode: "collector", name: "采集端B" });
  await host.configure({ mode: "host", name: "主机A" });
  const status = await host.discover({
    address: "127.0.0.1",
    port: collector.getSettings().port,
  });
  const peer = status.discovered.find(
    (entry) => entry.id === collector.getSettings().deviceId,
  );
  await collector.openPairing();
  const joining = await host.join(peer);
  const pending = collector.getStatus().pairing.pending[0];
  assert.equal(joining.joining.code, pending.code);
  assert.match(pending.code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  await assert.rejects(host.fetchReports(query), { status: 401 });
  await assert.rejects(
    collector.approve({ id: pending.id, code: "0000-0000-0000-0000" }),
    { status: 403 },
  );
  await collector.approve({ id: pending.id, code: pending.code });
  await waitUntil(() => host.getStatus().connected, "主机未完成配对和事件连接");
  return peer;
}

async function writeReport(root, index, sample = `${index} A`) {
  const folder = path.join(root, query.date, "instrument");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${index}.txt`);
  await fs.writeFile(
    file,
    `Date ${query.date}_07-00-${String(index % 60).padStart(2, "0")}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`,
  );
  const older = new Date(Date.now() - 10_000);
  await fs.utimes(file, older, older);
  return file;
}

test("默认单机仅持久化设备ID，不产生TLS密钥或网络监听", async (t) => {
  const f = await fixture(t);
  const first = await f.manager();
  assert.equal(first.getStatus().listening, false);
  await assert.rejects(fs.stat(path.join(f.home, "lan-identity.json")), {
    code: "ENOENT",
  });
  const id = first.getSettings().deviceId;
  await first.close();
  const second = await f.manager();
  assert.equal(second.getSettings().deviceId, id);
});

test("UDP discovery ignores non-object JSON and remains available to legitimate peers", async (t) => {
  const f = await fixture(t);
  const reservation = dgram.createSocket("udp4");
  await new Promise((resolve) => reservation.bind(0, "127.0.0.1", resolve));
  const discoveryPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const collector = await f.manager({ discovery: true, discoveryPort });
  await collector.configure({ mode: "collector", name: "Discovery B" });
  const socket = dgram.createSocket("udp4");
  t.after(() => socket.close());
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  for (const malformed of ["null", "[]", "42", "{broken"]) {
    await new Promise((resolve, reject) =>
      socket.send(
        Buffer.from(malformed),
        discoveryPort,
        "127.0.0.1",
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("UDP discovery did not recover")),
      3000,
    );
    socket.once("message", (message) => {
      clearTimeout(timeout);
      resolve(JSON.parse(message));
    });
  });
  socket.send(
    Buffer.from(
      JSON.stringify({
        tag: "lizi-lan-v1",
        type: "discover",
        nonce: "legitimate-probe",
      }),
    ),
    discoveryPort,
    "127.0.0.1",
  );
  const discovered = await response;
  assert.equal(discovered.id, collector.getSettings().deviceId);
  assert.equal(discovered.nonce, "legitimate-probe");
});

test(
  "未配对拒绝；本地确认后分页读取真实ReportStore，SSE变化与重启授权保留",
  { timeout: 60_000 },
  async (t) => {
    const a = await fixture(t);
    const b = await fixture(t);
    const host = await a.manager();
    const collector = await b.manager();
    for (let index = 0; index < 40; index++) await writeReport(b.root, index);
    const peer = await pair(host, collector);
    await assert.rejects(
      requestJson(peer, "/lan/snapshots", { method: "POST", body: query }),
      { status: 401 },
    );
    const first = await host.fetchReports(query);
    assert.equal(first.reports.length, 40);
    assert.equal(first.sourceId, collector.getSettings().deviceId);
    assert.deepEqual(
      new Set(first.reports.map((report) => report.sampleName)),
      new Set(Array.from({ length: 40 }, (_, index) => `${index} A`)),
    );
    let changed = false;
    host.on("change", ({ revision } = {}) => {
      if (revision > first.revision) changed = true;
    });
    await writeReport(b.root, 0, "100 changed");
    await b.store.scan();
    await waitUntil(() => changed, "报告真实修改未推送至主机");
    const updated = await host.fetchReports(query);
    assert.ok(
      updated.reports.some((report) => report.sampleName === "100 changed"),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      host.fetchReports(query, { signal: cancelled.signal }),
      { status: 499 },
    );
    const collectorPort = collector.getSettings().port;
    const collectorId = collector.getSettings().deviceId;
    await host.close();
    await collector.close();
    const collectorRestarted = await b.manager({ port: collectorPort });
    await collectorRestarted.start();
    const hostRestarted = await a.manager();
    await hostRestarted.start();
    await waitUntil(
      () => hostRestarted.getStatus().connected,
      "重启后未恢复已配对连接",
    );
    assert.equal(hostRestarted.getSettings().peer.id, collectorId);
    const afterRestart = await hostRestarted.fetchReports(query);
    assert.equal(afterRestart.reports.length, 40);
    assert.ok(
      afterRestart.reports.some(
        (report) => report.sampleName === "100 changed",
      ),
    );
    const publicState = JSON.stringify(hostRestarted.getStatus());
    assert.equal(publicState.includes("token"), false);
    assert.equal(publicState.includes("PRIVATE KEY"), false);
    await hostRestarted.disconnect();
    assert.equal(collectorRestarted.getSettings().peer, null);
    await assert.rejects(hostRestarted.fetchReports(query), { status: 401 });
  },
);

test("主机在批准前重启且双方在批准后重启仍可完成配对和撤销", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const host = await a.manager();
  const collector = await b.manager();
  await collector.configure({ mode: "collector", name: "采集端B" });
  await host.configure({ mode: "host", name: "主机A" });
  const hostId = host.getSettings().deviceId;
  const port = collector.getSettings().port;
  const discovered = await host.discover({ address: "127.0.0.1", port });
  await collector.openPairing();
  await host.join(discovered.discovered[0]);
  const pending = collector.getStatus().pairing.pending[0];
  await host.close();
  const waiting = await a.manager();
  assert.equal(waiting.getStatus().joining?.code, pending.code);
  await waiting.close();
  await collector.approve({ id: pending.id, code: pending.code });
  await collector.close();
  const restartedCollector = await b.manager({ port });
  await restartedCollector.start();
  const restartedHost = await a.manager();
  await waitUntil(
    () => restartedHost.getStatus().connected,
    "中断的握手未恢复",
  );
  await writeReport(b.root, 1, "重启后报告");
  const snapshot = await restartedHost.fetchReports(query);
  assert.equal(snapshot.reports[0].sampleName, "重启后报告");
  await restartedCollector.disconnect();
  await waitUntil(() => !restartedHost.getSettings().peer, "撤销未传播");
  await restartedHost.close();
  const revoked = await a.manager();
  assert.equal(revoked.getSettings().deviceId, hostId);
  assert.equal(revoked.getSettings().mode, "host");
  assert.equal(revoked.getStatus().joining, null);
  assert.equal(revoked.getSettings().peer, null);
  await pair(revoked, restartedCollector);
});

test("取消及过期的主机握手不会在重启后恢复", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const host = await a.manager();
  const collector = await b.manager();
  await collector.configure({ mode: "collector" });
  await host.configure({ mode: "host" });
  const discovered = await host.discover({
    address: "127.0.0.1",
    port: collector.getSettings().port,
  });
  await collector.openPairing();
  await host.join(discovered.discovered[0]);
  await host.disconnect();
  await host.close();
  const cancelled = await a.manager();
  assert.equal(cancelled.getStatus().joining, null);
  const port = collector.getSettings().port;
  await collector.close();
  const freshCollector = await b.manager({ port });
  await freshCollector.openPairing();
  await cancelled.join(discovered.discovered[0]);
  await cancelled.close();
  const file = path.join(a.home, "lan-settings.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.joining.expiresAt = Date.now() - 1000;
  await fs.writeFile(file, JSON.stringify(saved));
  const expired = await a.manager();
  await waitUntil(
    () => expired.getStatus().joining?.status === "expired",
    "握手未过期",
  );
  assert.equal(expired.getSettings().peer, null);
  await expired.close();
  const restarted = await a.manager();
  assert.equal(restarted.getStatus().joining, null);
});

test(
  "错证书在发送Bearer前失败，不能向攻击端泄露认证头",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const collector = await f.manager();
    await collector.configure({ mode: "collector" });
    const identity = JSON.parse(
      await fs.readFile(path.join(f.home, "lan-identity.json"), "utf8"),
    );
    let requests = 0;
    const server = https.createServer(
      { key: identity.key, cert: identity.cert },
      (_req, res) => {
        requests++;
        res.end("{}");
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const peer = {
      address: "127.0.0.1",
      port: server.address().port,
      fingerprint: `sha256:${"0".repeat(64)}`,
    };
    await assert.rejects(
      requestJson(peer, "/lan/snapshots", {
        method: "POST",
        body: query,
        token: "sensitive-token",
      }),
      { status: 495 },
    );
    assert.equal(requests, 0);
  },
);
