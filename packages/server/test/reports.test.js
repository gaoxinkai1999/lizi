import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseReport } from "@lizi/core";
import { openDatabase, setSetting } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";

const query = { date: "2026-09-23", shift: "day", excludeAggregate: false };
const report = (sample, date = "2026-09-23", time = "07-00-00") =>
  `Date ${date}_${time}\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`;

async function stableWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const older = new Date(Date.now() - 10000);
  await fs.utimes(file, older, older);
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-reports-"));
  const root = path.join(home, "reports");
  const other = path.join(home, "other");
  await fs.mkdir(root);
  await fs.mkdir(other);
  const policy = await createDirectoryPolicy(
    home,
    JSON.stringify([root, other]),
  );
  const db = openDatabase(home);
  const store = new ReportStore(db, policy);
  t.after(async () => {
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  await store.start();
  await store.setRoot(root);
  return { home, root, other, policy, db, store };
}

async function settled(store, selection = query) {
  await store.query(selection);
  await store.scan();
  return store.query(selection);
}

function nextStatus(store, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      store.off("status", listener);
      reject(new Error("Timed out waiting for report indexing"));
    }, 10000);
    function listener(status) {
      if (!predicate(status)) return;
      clearTimeout(timeout);
      store.off("status", listener);
      resolve(status);
    }
    store.on("status", listener);
  });
}

async function collect(snapshot) {
  const reports = [];
  for await (const row of snapshot.reports) reports.push(row);
  return reports;
}

test("startup/root selection never indexes history; date queries expose bounded batches and pagination", async (t) => {
  const { root, store } = await fixture(t);
  for (let index = 0; index < 160; index += 1) {
    await stableWrite(
      path.join(root, query.date, "instrument", `${index}.txt`),
      report(
        `${index} A`,
        query.date,
        `07-${String(Math.floor((159 - index) / 60)).padStart(2, "0")}-${String((159 - index) % 60).padStart(2, "0")}`,
      ),
    );
  }
  await stableWrite(
    path.join(root, "2010-01-01", "instrument", "history.txt"),
    report("999 old", "2010-01-01"),
  );
  await stableWrite(path.join(root, "loose.txt"), report("998 loose"));
  await stableWrite(
    path.join(root, query.date, "loose.txt"),
    report("997 loose"),
  );
  await stableWrite(
    path.join(root, query.date, "instrument", "Single_Report", "single.txt"),
    report("996 individual measurement"),
  );
  await store.setRoot(root);
  await store.scan();
  assert.equal(
    store.status().reportCount,
    0,
    "unrequested dates and loose files must never be traversed",
  );
  const counts = [];
  store.on("status", (status) => {
    if (status.scanning) counts.push(status.reportCount);
  });
  const initial = await store.query({ ...query, pageSize: 25 });
  assert.equal(initial.indexing, true);
  assert.equal(initial.total, 0);
  await store.scan();
  const first = await store.query({ ...query, pageSize: 25 });
  const second = await store.query({ ...query, page: 2, pageSize: 25 });
  assert.equal(first.total, 160);
  assert.equal(first.reports.length, 25);
  assert.equal(first.reports[0].sampleName, "159 A");
  assert.equal(first.reports[0].averageHardness, 0);
  assert.equal(second.reports[0].sampleName, "134 A");
  assert.ok(
    counts.some((count) => count > 0 && count < 160),
    "committed pages become visible before the date finishes",
  );
  assert.equal(store.status().reportCount, 160);
  const absent = await settled(store, { ...query, date: "2011-01-01" });
  assert.equal(
    absent.total,
    0,
    "missing date directories never fall back to the report root",
  );
  await assert.rejects(store.query({ ...query, pageSize: 101 }), {
    status: 400,
  });
});

test("unchanged invalid fingerprints are persisted and never re-parsed; watcher updates/deletes only active dates", async (t) => {
  const { root, store } = await fixture(t);
  const folder = path.join(root, query.date, "instrument");
  const file = path.join(folder, "a.txt");
  await stableWrite(file, report("2 A"));
  await stableWrite(path.join(folder, "broken.txt"), "half-written");
  assert.equal((await settled(store)).reports[0].sampleName, "2 A");
  assert.ok(
    store.errors.some(
      (error) => error.path === path.join(folder, "broken.txt"),
    ),
  );
  const revision = store.revision;
  await store.scan();
  assert.equal(store.revision, revision);
  assert.equal(store.status().scanProgress.parsed, 0);
  const updated = nextStatus(
    store,
    (status) => !status.scanning && status.revision > revision,
  );
  await stableWrite(file, report("3 B"));
  await updated;
  assert.equal((await store.query(query)).reports[0].sampleName, "3 B");
  const deletion = nextStatus(
    store,
    (status) => !status.scanning && status.reportCount === 0,
  );
  await fs.rm(folder, { recursive: true });
  await deletion;
  assert.equal((await store.query(query)).total, 0);
});

test("parser upgrade retries previously rejected reports only in requested dates", async (t) => {
  const { root, store, db } = await fixture(t);
  const file = path.join(root, query.date, "instrument", "legacy.txt");
  await stableWrite(
    file,
    `Date ${query.date}_08-00-00\nSample Name 2 legacy\nAVERAGE HARDNESS 125.4\n`,
  );
  const stat = await fs.stat(file);
  db.prepare(
    "INSERT INTO report_files(path,root,scope,fingerprint,valid,generation,error) VALUES(?,?,?,?,0,0,?)",
  ).run(
    file,
    root,
    query.date,
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    "missing optional summary",
  );
  const historical = path.join(root, "2010-01-01", "instrument", "legacy.txt");
  await stableWrite(
    historical,
    "Date 2010-01-01_08-00-00\nSample Name 1 history\n",
  );
  assert.equal(store.status().reportCount, 0);
  const result = await settled(store);
  assert.equal(result.total, 1);
  assert.equal(result.reports[0].sampleName, "2 legacy");
  assert.equal(result.reports[0].averageHardness, 125);
  assert.equal(result.reports[0].step, null);
  assert.equal(store.status().reportCount, 1);
  assert.deepEqual(store.status().activeDates, [query.date]);
  await store.scan();
  assert.equal(store.status().scanProgress.parsed, 0);
});

test("night/full activate two date directories and preserve aggregate export selection and repeatable snapshots", async (t) => {
  const { root, store } = await fixture(t);
  await stableWrite(
    path.join(root, query.date, "machine", "day.txt"),
    report("1 day"),
  );
  await stableWrite(
    path.join(root, query.date, "machine", "night.txt"),
    report("9 night", query.date, "20-00-00"),
  );
  await stableWrite(
    path.join(root, "2026-09-24", "machine", "morning.txt"),
    report("3 morning", "2026-09-24", "02-00-00"),
  );
  await stableWrite(
    path.join(root, "2026-09-24", "machine", "aggregate.txt"),
    report("4 总", "2026-09-24", "03-00-00"),
  );
  assert.equal((await settled(store)).total, 1);
  const night = { ...query, shift: "night" };
  const snapshot = await store.exportSnapshot(night);
  t.after(() => snapshot.close());
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.detailCount, 2);
  const before = (await collect(snapshot)).map((row) => row.sampleName);
  assert.deepEqual(before, ["9 night", "3 morning"]);
  await stableWrite(
    path.join(root, query.date, "machine", "night.txt"),
    report("2 changed", query.date, "20-00-00"),
  );
  await store.scan();
  assert.deepEqual(
    (await collect(snapshot)).map((row) => row.sampleName),
    before,
    "all worksheet passes read the same snapshot",
  );
  const selected = await store.exportSnapshot(night, { allSelected: true });
  assert.equal(selected.count, 3);
  await assert.rejects(store.exportSnapshot(night), { status: 429 });
  await selected.close();
  await snapshot.close();
  const full = await settled(store, { ...query, shift: "full" });
  assert.equal(full.total, 4);
});

test("root switch cancels an in-flight date scan and cannot leak old root rows", async (t) => {
  const { root, other, store } = await fixture(t);
  for (let index = 0; index < 80; index += 1) {
    await stableWrite(
      path.join(root, query.date, "machine", `${index}.txt`),
      report(`${index} A`),
    );
  }
  await stableWrite(
    path.join(other, query.date, "machine", "b.txt"),
    report("3 B"),
  );
  const scanning = nextStatus(
    store,
    (status) => status.scanning && status.reportCount > 0,
  );
  await store.query(query);
  await scanning;
  await store.setRoot(other);
  const page = await settled(store);
  assert.deepEqual(
    page.reports.map((row) => row.sampleName),
    ["3 B"],
  );
  assert.equal(store.status().root, other);
});

test("2.0.0 database migration preserves reports/settings/users and reconciles requested dates after restart", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-upgrade-"));
  const root = path.join(home, "reports");
  const file = path.join(root, query.date, "instrument", "legacy.txt");
  await stableWrite(file, report("2 legacy"));
  const policy = await createDirectoryPolicy(home, JSON.stringify([root]));
  const db = openDatabase(home);
  setSetting(db, "dataPath", root);
  setSetting(db, "authenticationEnabled", "true");
  db.prepare(
    "INSERT INTO users(id,username,password,role) VALUES('u','legacy','hash','admin')",
  ).run();
  const legacy = { ...parseReport(report("2 legacy")), id: "legacy-id" };
  db.prepare(
    "INSERT INTO reports(path,id,fingerprint,timestamp,line,aggregate,json) VALUES(?,?,?,?,?,?,?)",
  ).run(
    file,
    legacy.id,
    "legacy-fingerprint",
    `${query.date}T07:00:00`,
    2,
    0,
    JSON.stringify(legacy),
  );
  let store = new ReportStore(db, policy);
  t.after(async () => {
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  await store.start();
  assert.equal(
    (await store.query(query)).reports[0].id,
    "legacy-id",
    "persisted reports are readable before refresh",
  );
  assert.equal(
    db.prepare("SELECT username FROM users WHERE id='u'").get().username,
    "legacy",
  );
  assert.equal(
    db
      .prepare("SELECT value FROM settings WHERE key='authenticationEnabled'")
      .get().value,
    "true",
  );
  await store.close();
  await fs.rm(file);
  await stableWrite(
    path.join(root, query.date, "instrument", "new.txt"),
    report("10 new"),
  );
  store = new ReportStore(db, policy);
  await store.start();
  assert.deepEqual(
    (await settled(store)).reports.map((row) => row.sampleName),
    ["10 new"],
  );
});

test("closing cancels background work, and a worker failure is exposed without automatic restart", async (t) => {
  const { root, store, db, policy } = await fixture(t);
  for (let index = 0; index < 100; index += 1) {
    await stableWrite(
      path.join(root, query.date, "machine", `${index}.txt`),
      report(`${index} A`),
    );
  }
  await store.query(query);
  await store.close();
  await assert.rejects(store.query(query), { status: 503 });
  const failed = new ReportStore(db, policy);
  t.after(() => failed.close());
  await failed.start();
  const failure = nextStatus(
    failed,
    (status) => status.scanProgress.phase === "failed",
  );
  await failed.worker.terminate();
  await failure;
  await assert.rejects(failed.query(query), { status: 503 });
  assert.equal(failed.status().scanning, false);
  assert.match(failed.status().errors[0].message, /不可用/);
});

test("directory browsing rejects parent traversal and links outside approved roots", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-path-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "reports");
  const outside = path.join(home, "private");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const policy = await createDirectoryPolicy(home, JSON.stringify([root]));
  await assert.rejects(
    policy.resolveDirectory(path.join(root, "..", "private")),
    { status: 403 },
  );
  await assert.rejects(policy.resolveDirectory(path.join(root, "escape")), {
    status: 403,
  });
  assert.deepEqual((await policy.browse(root)).directories, []);
});
