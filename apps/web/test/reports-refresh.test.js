import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import * as vue from "vue";
import { parse, compileScript } from "vue/compiler-sfc";
import { buildRecordSheets } from "../../../packages/core/src/report-record.js";

const source = await fs.readFile(new URL("../src/components/ReportsView.vue", import.meta.url), "utf8");
const compiled = compileScript(parse(source).descriptor, { id: "report-refresh-test" }).content
  .replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g, (_, binding, name) =>
    binding.trim().startsWith("{")
      ? `const ${binding} = modules[${JSON.stringify(name)}];`
      : `const ${binding} = modules[${JSON.stringify(name)}].default;`)
  .replace("export default", "module.exports =");
const renderer = vue.createRenderer({
  createComment: () => ({}), insert() {}, remove() {},
  createText: () => ({}), setText() {}, parentNode() {}, nextSibling() {},
});

function result(overrides = {}) {
  return {
    root: "/reports", revision: 1, indexing: false, total: 1, page: 1, pageSize: 100,
    reports: [{
      id: "a".repeat(32), date: "2026-10-29", time: "08:00:00", line: 4,
      sampleName: "4 sample", testResults: [{ gram: 30 }], segmentInfoList: [],
    }],
    ...overrides,
  };
}

async function tick() {
  await new Promise(setImmediate);
  await vue.nextTick();
}

async function fixture(t, fetchReports = async () => result()) {
  const calls = [];
  const modules = {
    vue,
    "lucide-vue-next": {},
    "../api.js": {
      localDate: () => "2026-10-29",
      request: async (url) => {
        if (!url.startsWith("/reports?")) return {};
        calls.push(url);
        return fetchReports(calls.length);
      },
    },
    "../../../../packages/core/src/current-shift.js": {},
    "../offline-cache.js": {
      pageKey: (query) => JSON.stringify(query),
      readReportPage: async () => null,
      saveReportPage: async () => {},
    },
    "../report-images.js": {}, "../report-record-images.js": {},
    "../../../../packages/core/src/report-record.js": { buildRecordSheets },
    "./Modal.vue": {}, "./ReportDetail.vue": {},
  };
  const context = {
    module: { exports: {} }, modules, crypto, URLSearchParams, AbortController,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, queueMicrotask,
    fetch: async () => ({}),
  };
  vm.runInNewContext(compiled, context);
  const props = vue.reactive({
    today: "2026-10-29", refreshKey: 0, online: true, active: true, cacheScope: "test",
    transientReports: false, dataRoot: "/reports", deploymentMode: "client",
    scanStatus: { scanning: false },
  });
  let state;
  const app = renderer.createApp({
    setup() {
      state = context.module.exports.setup(props, { expose() {}, emit() {} });
      return () => null;
    },
  });
  app.mount({});
  t.after(() => app.unmount());
  await tick();
  return { state, props, calls };
}

test("background status and unrelated revisions preserve the displayed report objects", async (t) => {
  const { state, props, calls } = await fixture(t, async (n) => result({ revision: n }));
  const reports = state.reports.value;
  const sheet = state.activeSheet.value;
  props.scanStatus.scanning = true;
  await tick();
  props.scanStatus.scanning = false;
  await tick();
  assert.equal(calls.length, 1, "routine scans with a ready page do not query again");
  props.refreshKey++;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(state.reports.value, reports);
  assert.equal(state.activeSheet.value, sheet);
  assert.equal(state.loading.value, false);
});

test("notifications during a slow background request coalesce into one follow-up", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { state, props, calls } = await fixture(t, async (n) => {
    if (n === 2) await gate;
    return result();
  });
  props.refreshKey++;
  await tick();
  for (let n = 0; n < 10; n++) {
    props.refreshKey++;
    await tick();
  }
  assert.equal(calls.length, 2, "only one background request may be in flight");
  assert.equal(state.loading.value, false);
  release();
  await tick();
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(state.loading.value, false);
});

test("unchanged data still clears indexing and updates source warnings", async (t) => {
  const { state, props } = await fixture(t, async (n) =>
    result(n === 1 ? { indexing: true } : { warnings: ["source offline"] }));
  const reports = state.reports.value;
  props.scanStatus.scanning = true;
  await tick();
  props.scanStatus.scanning = false;
  await tick();
  assert.equal(state.indexing.value, false);
  assert.equal(state.readyForActions.value, true);
  assert.equal(state.reports.value, reports);
  assert.deepEqual(Array.from(state.sourceWarnings.value), ["source offline"]);
});

test("a real changed measurement reaches the visible record sheet", async (t) => {
  const { state, props } = await fixture(t, async (n) => {
    const next = result({ revision: n });
    next.reports[0].testResults[0].gram = n === 1 ? 30 : 17;
    return next;
  });
  props.refreshKey++;
  await tick();
  assert.equal(state.activeSheet.value.rows[0][0], 17);
  assert.equal(state.activeSheet.value.summary.average[0], 17);
});
