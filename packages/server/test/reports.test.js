import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/database.js";
import { createDirectoryPolicy } from "../src/directories.js";
import { ReportStore } from "../src/reports.js";

const report = (sample) =>
  `Date 2026-09-23_07-00-00\nSample Name ${sample}\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n`;
async function stableWrite(file, content) {
  await fs.writeFile(file, content);
  const older = new Date(Date.now() - 10000);
  await fs.utimes(file, older, older);
}

test("restart reconciles nested additions/deletions and a root switch cannot leak old reports", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-cache-"));
  const rootA = path.join(home, "a");
  const rootB = path.join(home, "b");
  const nested = path.join(rootA, "2026-09-23", "instrument", "nested");
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(rootB);
  const fileA = path.join(nested, "a.txt");
  await stableWrite(fileA, report("2 A"));
  await stableWrite(path.join(nested, "broken.txt"), "half-written");
  let db = openDatabase(home);
  const policy = await createDirectoryPolicy(
    home,
    JSON.stringify([rootA, rootB]),
  );
  let store = new ReportStore(db, policy);
  t.after(async () => {
    await store.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  await store.setRoot(rootA);
  const query = { date: "2026-09-23", shift: "day", excludeAggregate: false };
  assert.equal(store.query(query)[0].sampleName, "2 A");
  assert.match(store.errors[0].message, /日期/);
  const revision = store.revision;
  await store.scan();
  assert.equal(
    store.revision,
    revision,
    "unchanged files do not emit a new data revision",
  );
  await store.close();
  db.close();
  await fs.rm(fileA);
  await stableWrite(path.join(nested, "new.txt"), report("10 B"));
  db = openDatabase(home);
  store = new ReportStore(db, policy);
  await store.start();
  assert.deepEqual(
    store.query(query).map((row) => row.sampleName),
    ["10 B"],
  );
  await stableWrite(path.join(rootB, "b.txt"), report("3 C"));
  await store.setRoot(rootB);
  assert.deepEqual(
    store.query(query).map((row) => row.sampleName),
    ["3 C"],
  );
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
