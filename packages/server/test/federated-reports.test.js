import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { filterReports, parseReport } from "@lizi/core";
import { openDatabase } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";
import { FederatedReportStore } from "../src/federated-reports.js";

const query = {
  date: "2026-09-23",
  shift: "day",
  excludeAggregate: false,
  clientId: "viewer-a",
};
const text = (sample, date = query.date, time = "08-00-00") =>
  `Date ${date}_${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`;
const remote = (number, sample, date = query.date, time = "08-00-00") => ({
  ...parseReport(text(sample, date, time)),
  id: number.toString(16).padStart(32, "0"),
});

class LanStub extends EventEmitter {
  constructor() {
    super();
    this.settings = {
      mode: "host",
      deviceId: "host-a",
      name: "主机A",
      epoch: 1,
      peers: [{ id: "collector-b", name: "采集端B", canQuery: true }],
    };
    this.connected = true;
    this.rows = [];
    this.errors = [];
    this.calls = [];
    this.gate = null;
    this.sources = new Map();
  }
  getSettings() {
    return this.settings;
  }
  getStatus() {
    return {
      ...this.settings,
      connected: this.connected,
      peers: this.settings.peers.map((peer) => ({
        ...peer,
        connected: this.sources.get(peer.id)?.connected ?? this.connected,
      })),
    };
  }
  hold() {
    let resume;
    this.gate = new Promise((resolve) => {
      resume = resolve;
    });
    return () => {
      this.gate = null;
      resume();
    };
  }
  async fetchReports(params, { peerId, signal }) {
    this.calls.push({ params, peerId, signal });
    await this.gate;
    const source = this.sources.get(peerId);
    if (!(source?.connected ?? this.connected)) throw new Error("来源连接中断");
    return {
      reports: structuredClone(filterReports(source?.rows ?? this.rows, params)),
      sourceId: peerId,
      sourceName: this.settings.peers.find((peer) => peer.id === peerId).name,
      revision: this.calls.length,
      errors: source?.errors ?? this.errors,
    };
  }
  connection(connected) {
    this.connected = connected;
    this.emit("status");
  }
}

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-federated-"));
  const root = path.join(home, "reports");
  await fs.mkdir(root);
  const policy = await createDirectoryPolicy(home, JSON.stringify([root]));
  const db = openDatabase(home);
  const local = new ReportStore(db, policy);
  const lan = new LanStub();
  const store = new FederatedReportStore(local, lan, options);
  t.after(async () => {
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  await store.start();
  await store.setRoot(root);
  async function write(name, sample, date = query.date, time = "08-00-00") {
    const file = path.join(root, date, "machine", name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text(sample, date, time));
    const old = new Date(Date.now() - 10000);
    await fs.utimes(file, old, old);
    return file;
  }
  async function index(params = query) {
    await local.query(params);
    await local.scan();
    return local.query(params);
  }
  return { store, lan, local, root, write, index };
}

async function until(action, predicate) {
  const deadline = Date.now() + 10000;
  do {
    const result = await action();
    if (predicate(result)) return result;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail("联邦报告状态等待超时");
}

async function ready(store, params = query) {
  return until(
    () => store.query(params),
    (page) => !page.indexing && !page.incomplete,
  );
}

async function collect(snapshot) {
  const rows = [];
  for await (const row of snapshot.reports) rows.push(row);
  return rows;
}

test("首次查询不等待网络；相同原始ID保留本地ID且远端命名空间稳定，深分页按时间合并", async (t) => {
  const { store, lan, write, index } = await fixture(t);
  for (let i = 0; i < 12; i++)
    await write(
      `${i}.txt`,
      `1 local-${i}`,
      query.date,
      `08-${String(i * 2).padStart(2, "0")}-00`,
    );
  const localPage = await index();
  lan.rows = Array.from({ length: 12 }, (_, i) =>
    remote(
      i + 1,
      `2 remote-${i}`,
      query.date,
      `08-${String(i * 2 + 1).padStart(2, "0")}-00`,
    ),
  );
  lan.rows[0].id = localPage.reports[0].id;
  const resume = lan.hold();
  const first = await store.query({ ...query, pageSize: 5 });
  assert.equal(first.total, 12);
  assert.equal(first.indexing, true);
  await assert.rejects(store.exportSnapshot(query), { status: 409 });
  resume();
  const complete = await ready(store);
  assert.equal(complete.total, 24);
  assert.equal(
    complete.reports.find((row) => row.sampleName === "1 local-0").id,
    localPage.reports[0].id,
  );
  const distant = complete.reports.find(
    (row) => row.sampleName === "2 remote-0",
  );
  assert.match(distant.id, /^[a-f0-9]{32}$/);
  assert.notEqual(distant.id, localPage.reports[0].id);
  assert.equal(distant.sourceId, "collector-b");
  const keys = complete.reports.map(
    (row) => `${row.date}T${row.time}/${row.id}`,
  );
  assert.deepEqual(keys, [...keys].sort());
  const paged = [];
  for (let page = 1; page <= 5; page++)
    paged.push(...(await store.query({ ...query, page, pageSize: 5 })).reports);
  assert.deepEqual(
    paged.map((row) => row.id),
    complete.reports.map((row) => row.id),
  );
  assert.equal(
    (await store.query({ ...query, page: 20, pageSize: 5 })).reports.length,
    0,
  );
  lan.emit("change");
  assert.equal(
    (await ready(store)).reports.find(
      (row) => row.sampleName === distant.sampleName,
    ).id,
    distant.id,
  );
});

test("断线缓存保留并阻止部分导出，重连权威刷新删除已消失报告", async (t) => {
  const { store, lan, write, index } = await fixture(t);
  await write("local.txt", "1 local");
  await index();
  lan.rows = [remote(1, "2 deleted"), remote(2, "2 kept")];
  const before = await ready(store);
  lan.connection(false);
  const offline = await store.query(query);
  assert.equal(offline.total, before.total);
  assert.equal(offline.incomplete, true);
  assert.ok(offline.warnings.some((warning) => warning.includes("离线")));
  await assert.rejects(
    store.exportSnapshot(query, { ids: [before.reports[0].id] }),
    { status: 503 },
  );
  lan.rows = [remote(2, "2 kept")];
  lan.connection(true);
  const recovered = await ready(store);
  assert.deepEqual(recovered.reports.map((row) => row.sampleName).sort(), [
    "1 local",
    "2 kept",
  ]);
  assert.ok(recovered.revision > before.revision);
  await assert.rejects(
    store.exportSnapshot(query, {
      ids: [before.reports.find((row) => row.sampleName === "2 deleted").id],
    }),
    { status: 409 },
  );
});

test("释放最后一个租约取消请求；迟到响应、远端change和重连不会重新获得已释放scope", async (t) => {
  const { store, lan, index } = await fixture(t);
  await index();
  lan.rows = [remote(1, "2 remote")];
  const resume = lan.hold();
  await store.query(query);
  await until(
    async () => lan.calls.length,
    (count) => count === 1,
  );
  store.release(query.clientId);
  assert.equal(lan.calls[0].signal.aborted, true);
  resume();
  lan.emit("change");
  lan.connection(false);
  lan.connection(true);
  await delay(80);
  assert.equal(store.status().cache.scopes, 0);
  assert.equal(store.status().cache.bytes, 0);
  assert.equal(lan.calls.length, 1);
  await assert.rejects(store.exportSnapshot(query), { status: 409 });
});

test("共享日期租约、四scope上限、临时API租约及超时互不抢占", async (t) => {
  let now = Date.now();
  const { store, lan, index } = await fixture(t, { now: () => now });
  await index();
  const first = await ready(store);
  store.touch(query, "viewer-b");
  store.release(query.clientId);
  assert.equal(store.status().cache.scopes, 1);
  assert.equal(
    (await store.query({ ...query, clientId: "viewer-b" })).total,
    first.total,
  );
  for (let day = 24; day <= 26; day++)
    store.touch({ ...query, date: `2026-09-${day}` }, `viewer-${day}`);
  assert.throws(() => store.touch({ ...query, date: "2026-09-27" }, "extra"), {
    status: 503,
  });
  assert.throws(
    () => store.touch({ ...query, date: "2026-09-27", clientId: undefined }),
    { status: 503 },
  );
  assert.equal(store.status().cache.clients, 4);
  store.touch({ ...query, date: "2026-09-27" }, "viewer-b");
  assert.equal(store.status().cache.scopes, 4, "切换仅释放自己的旧scope");
  now += 60001;
  store.touch(query, "fresh-viewer");
  assert.equal(store.status().cache.clients, 1);
  assert.equal(store.status().cache.scopes, 1);
  lan.settings = { ...lan.settings, epoch: 2, peers: [] };
  lan.emit("configuration");
  assert.equal(store.status().cacheEpoch, 2);
  assert.equal(store.status().cache.scopes, 0);
});

test("客户端128上限不驱逐已有读者", async (t) => {
  const { store } = await fixture(t);
  for (let i = 0; i < 128; i++) store.touch(query, `viewer-${i}`);
  assert.throws(() => store.touch(query, "overflow"), { status: 503 });
  store.release("viewer-0");
  store.touch(query, "replacement");
  assert.equal(store.status().cache.clients, 128);
  assert.equal(store.status().cache.scopes, 1);
});

test("跨夜日期只合并班次范围，混合导出三遍不可变且正确处理总分析及未知选择", async (t) => {
  const { store, lan, write, index, local } = await fixture(t);
  const night = { ...query, shift: "night" };
  const localFile = await write("night.txt", "1 local", query.date, "20-00-00");
  await write("total.txt", "1 总", "2026-09-24", "03-00-00");
  await write("outside.txt", "1 outside", "2026-09-24", "07-00-00");
  await index(night);
  lan.rows = [
    remote(1, "2 remote", "2026-09-24", "02-00-00"),
    remote(2, "2 总", "2026-09-24", "04-00-00"),
    remote(3, "2 outside", "2026-09-24", "07-00-00"),
  ];
  const page = await ready(store, night);
  assert.equal(page.total, 4);
  const snapshot = await store.exportSnapshot(night);
  const first = await collect(snapshot);
  assert.deepEqual(
    first.map((row) => row.sampleName),
    ["1 local", "2 remote"],
  );
  assert.deepEqual(
    first.map((row) => row.sourceId),
    ["host-a", "collector-b"],
  );
  assert.equal(snapshot.detailCount, 2);
  const all = await store.exportSnapshot(night, { allSelected: true });
  assert.equal(all.count, 4);
  await assert.rejects(store.exportSnapshot(night), { status: 429 });
  await all.close();
  await fs.rm(localFile);
  await local.scan();
  lan.rows = [];
  lan.emit("change");
  await ready(store, night);
  for (let pass = 0; pass < 2; pass++)
    assert.deepEqual(await collect(snapshot), first);
  store.release(query.clientId);
  assert.ok(
    store.status().cache.bytes > 0,
    "已释放scope仍被导出引用的远端快照必须计费",
  );
  assert.deepEqual(await collect(snapshot), first);
  await snapshot.close();
  assert.equal(store.status().cache.bytes, 0);
  await assert.rejects(collect(snapshot), { status: 410 });
  lan.rows = [remote(4, "2 new", "2026-09-24", "02-00-00")];
  const current = await ready(store, night);
  const selected = await store.exportSnapshot(night, {
    ids: current.reports.map((row) => row.id),
  });
  assert.deepEqual(
    (await collect(selected)).map((row) => row.id),
    current.reports.map((row) => row.id),
  );
  await selected.close();
  await assert.rejects(store.exportSnapshot(night, { ids: ["f".repeat(32)] }), {
    status: 409,
  });
});

test("单次内存上限失败保留旧数据，导出引用和并发传输预留均计入总预算", async (t) => {
  const { store, lan, index } = await fixture(t, {
    maxBytes: 5000,
    maxRemoteBytes: 3000,
  });
  await index();
  lan.rows = [remote(1, "2 small")];
  const initial = await ready(store);
  const snapshot = await store.exportSnapshot(query, { allSelected: true });
  lan.rows = [remote(2, `2 ${"大".repeat(2000)}`)];
  lan.emit("change");
  const failed = await until(
    () => store.query(query),
    (page) => !page.indexing && page.warnings.length > 0,
  );
  assert.deepEqual(
    failed.reports.map((row) => row.id),
    initial.reports.map((row) => row.id),
  );
  assert.ok(store.status().cache.bytes <= 5000);
  await assert.rejects(store.exportSnapshot(query), { status: 503 });
  assert.deepEqual(
    (await collect(snapshot)).map((row) => row.id),
    initial.reports.map((row) => row.id),
  );
  await snapshot.close();
  lan.rows = [remote(3, "2 recovered")];
  lan.emit("change");
  assert.equal((await ready(store)).reports[0].sampleName, "2 recovered");
  store.release(query.clientId);
  assert.equal(store.status().cache.bytes, 0);
});

test("已释放scope的导出引用仍占预算，关闭快照后才能恢复同步", async (t) => {
  const { store, lan, index } = await fixture(t, {
    maxBytes: 1800,
    maxRemoteBytes: 1400,
  });
  await index();
  lan.rows = [remote(1, "2 retained")];
  await ready(store);
  const snapshot = await store.exportSnapshot(query);
  store.release(query.clientId);
  assert.ok(store.status().cache.bytes > 0);
  const blocked = await until(
    () => store.query(query),
    (page) => !page.indexing && page.warnings.length > 0,
  );
  assert.equal(blocked.incomplete, true);
  assert.equal((await collect(snapshot))[0].sampleName, "2 retained");
  assert.equal(lan.calls.length, 1, "预算不足必须在发起传输前拒绝");
  await snapshot.close();
  lan.emit("change");
  assert.equal((await ready(store)).reports[0].sampleName, "2 retained");
});

test("有数据但远端索引报告错误时也不可当作完整结果导出", async (t) => {
  const { store, lan, index } = await fixture(t);
  await index();
  lan.rows = [remote(1, "2 partial")];
  lan.errors = [{ message: "另一个报告无法解析" }];
  const page = await until(
    () => store.query(query),
    (value) => !value.indexing && value.warnings.length > 0,
  );
  assert.equal(page.reports[0].sampleName, "2 partial");
  assert.equal(page.incomplete, true);
  assert.equal(
    page.sources.find((source) => source.id === "collector-b").state,
    "error",
  );
  await assert.rejects(store.exportSnapshot(query), { status: 503 });
  lan.errors = [];
  lan.emit("change");
  await ready(store);
  const snapshot = await store.exportSnapshot(query);
  assert.equal(snapshot.count, 1);
  await snapshot.close();
});

test("同一scope在途变更合并成一次后继同步且close后不再请求", async (t) => {
  const { store, lan, index } = await fixture(t);
  await index();
  lan.rows = [remote(1, "2 remote")];
  const resume = lan.hold();
  await store.query(query);
  await until(
    async () => lan.calls.length,
    (count) => count === 1,
  );
  for (let i = 0; i < 20; i++) lan.emit("change");
  resume();
  await ready(store);
  assert.equal(lan.calls.length, 2);
  await store.close();
  lan.emit("change");
  lan.connection(true);
  await delay(60);
  assert.equal(lan.calls.length, 2);
  assert.equal(store.status().cache.bytes, 0);
});

test("没有报告来源时各模式无需远端租约，保留本机ID及默认总分析排除语义", async (t) => {
  const { store, lan, write, index } = await fixture(t);
  await write("local.txt", "1 local");
  await write("total.txt", "1 总");
  const original = await index();
  for (const mode of ["standalone", "collector", "host"]) {
    lan.settings = { ...lan.settings, mode, peers: [] };
    lan.emit("configuration");
    const page = await store.query(query);
    assert.equal(page.transient, false);
    assert.deepEqual(
      page.reports.map((row) => row.id),
      original.reports.map((row) => row.id),
    );
    const snapshot = await store.exportSnapshot(query);
    assert.deepEqual(
      (await collect(snapshot)).map((row) => row.sampleName),
      ["1 local"],
    );
    await snapshot.close();
  }
  assert.equal(lan.calls.length, 0);
  assert.equal(store.status().cache.clients, 0);
});

test("多个来源ID隔离、单源离线不丢其他数据、定向移除与导出租约释放", async (t) => {
  const { store, lan, write, index } = await fixture(t);
  await write("local.txt", "1 local");
  const local = await index();
  lan.rows = [remote(1, "2 first")];
  lan.rows[0].id = local.reports[0].id;
  const initial = await ready(store);
  const originalId = initial.reports.find((row) => row.sourceId === "collector-b").id;
  for (const [id, name] of [["collector-c", "第三设备"], ["collector-d", "第四设备"]]) {
    lan.settings.peers.push({ id, name, canQuery: true });
    lan.sources.set(id, { connected: true, rows: [{ ...lan.rows[0], sampleName: name }] });
  }
  lan.settings.epoch++;
  lan.emit("configuration");
  const combined = await ready(store);
  assert.deepEqual(new Set(combined.reports.map((row) => row.sourceId)),
    new Set(["host-a", "collector-b", "collector-c", "collector-d"]));
  assert.equal(new Set(combined.reports.map((row) => row.id)).size, 4);
  assert.equal(combined.reports.find((row) => row.sourceId === "collector-b").id, originalId);
  const snapshot = await store.exportSnapshot(query, { allSelected: true });
  const pinned = await collect(snapshot);
  lan.sources.get("collector-c").connected = false;
  lan.sources.get("collector-d").rows = [remote(2, "4 refreshed")];
  lan.emit("change");
  const offline = await until(() => store.query(query), (page) => !page.indexing && page.incomplete);
  assert.equal(offline.sources.find((source) => source.id === "collector-c").state, "offline");
  assert.equal(offline.sources.find((source) => source.id === "collector-d").state, "ready");
  assert.ok(offline.reports.some((row) => row.sampleName === "4 refreshed"));
  assert.ok(offline.reports.some((row) => row.sampleName === "第三设备"));
  assert.deepEqual(await collect(snapshot), pinned);
  await assert.rejects(store.exportSnapshot(query), { status: 503 });
  await snapshot.close();
  lan.settings.peers = lan.settings.peers.filter((peer) => peer.id !== "collector-c");
  lan.settings.epoch++;
  lan.emit("configuration");
  const remaining = await ready(store);
  assert.deepEqual(new Set(remaining.reports.map((row) => row.sourceId)),
    new Set(["host-a", "collector-b", "collector-d"]));
  assert.equal(remaining.reports.find((row) => row.sourceId === "collector-b").id, originalId);
  assert.ok(store.status().cache.bytes <= store.status().cache.maxBytes);
  store.release(query.clientId);
  assert.equal(store.status().cache.bytes, 0);
  assert.equal(store.status().cache.clients, 0);
});

test("释放多源在途日期租约后不发起后续来源请求", async (t) => {
  const { store, lan, index } = await fixture(t);
  await index();
  lan.settings.peers.push({ id: "collector-c", name: "第三设备", canQuery: true });
  const resume = lan.hold();
  await store.query(query);
  await until(async () => lan.calls.length, (count) => count === 1);
  store.release(query.clientId);
  resume();
  await until(async () => store.status().cache.reservedBytes, (bytes) => bytes === 0);
  assert.equal(lan.calls.length, 1);
  assert.equal(store.status().cache.bytes, 0);
});
