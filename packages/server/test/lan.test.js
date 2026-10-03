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
  await assert.rejects(host.fetchReports(query, { peerId: peer.id }), { status: 401 });
  await assert.rejects(
    collector.approve({ id: pending.id, code: "0000-0000-0000-0000" }),
    { status: 403 },
  );
  await collector.approve({ id: pending.id, code: pending.code });
  await waitUntil(() => host.getStatus().peers.find((entry) => entry.id === peer.id)?.connected, "未完成配对和事件连接");
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
    const first = await host.fetchReports(query, { peerId: peer.id });
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
    const updated = await host.fetchReports(query, { peerId: peer.id });
    assert.ok(
      updated.reports.some((report) => report.sampleName === "100 changed"),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      host.fetchReports(query, { peerId: peer.id, signal: cancelled.signal }),
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
    assert.equal(hostRestarted.getSettings().peers[0].id, collectorId);
    const afterRestart = await hostRestarted.fetchReports(query, { peerId: collectorId });
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
    assert.deepEqual(collectorRestarted.getSettings().peers, []);
    await assert.rejects(hostRestarted.fetchReports(query, { peerId: collectorId }), { status: 401 });
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
  const snapshot = await restartedHost.fetchReports(query, { peerId: restartedCollector.getSettings().deviceId });
  assert.equal(snapshot.reports[0].sampleName, "重启后报告");
  await restartedCollector.disconnect();
  await waitUntil(() => !restartedHost.getSettings().peers.length, "撤销未传播");
  await restartedHost.close();
  const revoked = await a.manager();
  assert.equal(revoked.getSettings().deviceId, hostId);
  assert.equal(revoked.getSettings().mode, "host");
  assert.equal(revoked.getStatus().joining, null);
  assert.deepEqual(revoked.getSettings().peers, []);
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
  assert.deepEqual(expired.getSettings().peers, []);
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

test("旧单源授权迁移后添加两个来源，定向断开、撤销及独立重连不影响其他来源", { timeout: 120_000 }, async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const c = await fixture(t);
  const d = await fixture(t);
  const viewerFixture = await fixture(t);
  let host = await a.manager();
  let first = await b.manager();
  const second = await c.manager();
  const third = await d.manager();
  await writeReport(a.root, 1, "本机报告");
  await writeReport(b.root, 1, "来源一");
  await writeReport(c.root, 1, "来源二");
  await writeReport(d.root, 1, "来源三");
  const firstPeer = await pair(host, first);
  const hostId = host.getSettings().deviceId;
  const firstPort = first.getSettings().port;
  await host.close();
  await first.close();
  const credentials = [];
  for (const home of [a.home, b.home]) {
    const file = path.join(home, "lan-settings.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    saved.peer = saved.peers[0];
    credentials.push(saved.peer.token ?? saved.peer.tokenHash);
    delete saved.peers;
    await fs.writeFile(file, JSON.stringify(saved));
  }
  first = await b.manager({ port: firstPort });
  await first.start();
  host = await a.manager();
  await waitUntil(() => host.getStatus().peers[0]?.connected, "旧授权迁移后未连接");
  assert.equal(host.getSettings().deviceId, hostId);
  for (const [index, home] of [a.home, b.home].entries()) {
    const saved = JSON.parse(await fs.readFile(path.join(home, "lan-settings.json"), "utf8"));
    assert.equal(Object.hasOwn(saved, "peer"), false);
    assert.equal(saved.peers[0].token ?? saved.peers[0].tokenHash, credentials[index]);
  }
  const secondPeer = await pair(host, second);
  const thirdPeer = await pair(host, third);
  assert.deepEqual(new Set(host.getSettings().peers.map((peer) => peer.id)),
    new Set([firstPeer.id, secondPeer.id, thirdPeer.id]));
  for (const [peer, sampleName] of [[firstPeer, "来源一"], [secondPeer, "来源二"], [thirdPeer, "来源三"]]) {
    const result = await host.fetchReports(query, { peerId: peer.id });
    assert.equal(result.sourceId, peer.id);
    assert.deepEqual(result.reports.map((report) => report.sampleName), [sampleName]);
  }
  const viewer = await viewerFixture.manager();
  const aggregatePeer = await pair(viewer, host);
  await host.configure({ mode: "host" });
  await waitUntil(() => viewer.getStatus().peers[0]?.connected, "汇总节点未恢复服务");
  const localOnly = await viewer.fetchReports(query, { peerId: aggregatePeer.id });
  assert.equal(localOnly.sourceId, hostId);
  assert.deepEqual(localOnly.reports.map((report) => report.sampleName), ["本机报告"]);

  await host.disconnect({ id: secondPeer.id });
  assert.deepEqual(second.getSettings().peers, []);
  assert.ok(host.getSettings().peers.some((peer) => peer.id === firstPeer.id));
  assert.ok(host.getSettings().peers.some((peer) => peer.id === thirdPeer.id));
  await first.close();
  await waitUntil(() => !host.getStatus().peers.find((peer) => peer.id === firstPeer.id)?.connected, "离线状态未更新");
  assert.equal((await host.fetchReports(query, { peerId: thirdPeer.id })).reports[0].sampleName, "来源三");
  first = await b.manager();
  await first.start();
  await host.discover({ address: "127.0.0.1", port: first.getSettings().port });
  await waitUntil(() => host.getStatus().peers.find((peer) => peer.id === firstPeer.id)?.connected, "单源地址变更未恢复");
  assert.equal((await host.fetchReports(query, { peerId: firstPeer.id })).reports[0].sampleName, "来源一");
  await third.disconnect({ id: hostId });
  await waitUntil(() => !host.getSettings().peers.some((peer) => peer.id === thirdPeer.id), "单源撤销未传播");
  assert.ok(host.getStatus().peers.find((peer) => peer.id === firstPeer.id)?.connected);
  assert.ok(host.getSettings().peers.some((peer) => peer.id === viewer.getSettings().deviceId));
  await host.close();
  host = await a.manager();
  await waitUntil(() => host.getStatus().peers.find((peer) => peer.id === firstPeer.id)?.connected, "重启后未保留剩余授权");
  assert.equal((await host.fetchReports(query, { peerId: firstPeer.id })).reports[0].sampleName, "来源一");
  assert.deepEqual(host.getSettings().peers.filter((peer) => peer.canQuery).map((peer) => peer.id), [firstPeer.id]);
  assert.equal(first.snapshots.size, 0);
});

test("新配对不会覆盖先前已批准票据，重启可恢复多个查看设备且快照互相隔离", { timeout: 90_000 }, async (t) => {
  const sourceFixture = await fixture(t);
  const firstFixture = await fixture(t);
  const secondFixture = await fixture(t);
  let source = await sourceFixture.manager();
  let first = await firstFixture.manager();
  const second = await secondFixture.manager();
  await source.configure({ mode: "host" });
  await first.configure({ mode: "collector" });
  await second.configure({ mode: "host" });
  await writeReport(sourceFixture.root, 1, "唯一的本机报告");
  const port = source.getSettings().port;
  const discovered = await first.discover({ address: "127.0.0.1", port });
  const peer = discovered.discovered.find((entry) => entry.id === source.getSettings().deviceId);
  await source.openPairing();
  await first.join(peer);
  const pending = source.getStatus().pairing.pending[0];
  await first.close();
  await source.approve({ id: pending.id, code: pending.code });
  await new Promise((resolve) => setTimeout(resolve, 3100));
  await source.openPairing();
  await second.join(peer);
  const nextPending = source.getStatus().pairing.pending[0];
  await source.approve({ id: nextPending.id, code: nextPending.code });
  await waitUntil(() => second.getStatus().peers[0]?.connected, "第二个授权未完成");
  await source.close();
  source = await sourceFixture.manager({ port });
  await source.start();
  first = await firstFixture.manager();
  await waitUntil(() => first.getStatus().peers[0]?.connected, "第一个已批准票据被覆盖");
  await waitUntil(() => second.getStatus().peers[0]?.connected, "第二个授权未恢复");
  const firstSaved = JSON.parse(await fs.readFile(path.join(firstFixture.home, "lan-settings.json"), "utf8"));
  const secondSaved = JSON.parse(await fs.readFile(path.join(secondFixture.home, "lan-settings.json"), "utf8"));
  const firstAuth = firstSaved.peers[0].token;
  const secondAuth = secondSaved.peers[0].token;
  const snapshot = await requestJson(peer, "/lan/snapshots", { method: "POST", body: query, token: firstAuth });
  await assert.rejects(requestJson(peer, `/lan/snapshots/${snapshot.id}`, { token: secondAuth }), { status: 410 });
  await assert.rejects(requestJson(peer, `/lan/snapshots/${snapshot.id}`, { method: "DELETE", token: secondAuth }), { status: 410 });
  const own = await requestJson(peer, `/lan/snapshots/${snapshot.id}`, { token: firstAuth });
  assert.deepEqual(own.reports.map((report) => report.sampleName), ["唯一的本机报告"]);
  await requestJson(peer, `/lan/snapshots/${snapshot.id}`, { method: "DELETE", token: firstAuth }).catch((error) => {
    if (error.status !== 410) throw error;
  });
  await source.disconnect({ id: first.getSettings().deviceId });
  await waitUntil(() => !first.getSettings().peers.length, "定向撤销未传播");
  assert.equal((await second.fetchReports(query, { peerId: peer.id })).reports[0].sampleName, "唯一的本机报告");
  assert.equal(source.snapshots.size, 0);
});

test("八设备上限拒绝新增，未知设备移除不影响列表，定向移除后可继续配对", async (t) => {
  const f = await fixture(t);
  const initial = await f.manager();
  await initial.close();
  const file = path.join(f.home, "lan-settings.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.mode = "collector";
  saved.peers = Array.from({ length: 8 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `设备${index + 1}`,
    address: "127.0.0.1",
    port: 3211,
    fingerprint: `sha256:${"1".repeat(64)}`,
    tokenHash: String(index + 1).repeat(64),
  }));
  await fs.writeFile(file, JSON.stringify(saved));
  const lan = await f.manager();
  await lan.start();
  await assert.rejects(lan.openPairing(), { status: 409 });
  await assert.rejects(lan.join({}), { status: 409 });
  await assert.rejects(lan.disconnect({ id: "unknown" }), { status: 404 });
  assert.deepEqual(lan.getSettings().peers.map((peer) => peer.id), saved.peers.map((peer) => peer.id));
  await lan.disconnect({ id: saved.peers[3].id });
  assert.deepEqual(lan.getSettings().peers.map((peer) => peer.id), saved.peers.filter((_, index) => index !== 3).map((peer) => peer.id));
  const opened = await lan.openPairing();
  assert.ok(opened.pairing.openUntil > Date.now());
});
