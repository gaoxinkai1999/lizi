import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import * as vue from "vue";
import { renderToString } from "vue/server-renderer";
import { parse, compileScript, compileTemplate } from "vue/compiler-sfc";
import { buildRecordSheets } from "../../../packages/core/src/report-record.js";
import { currentShift } from "../../../packages/core/src/current-shift.js";

const source = await fs.readFile(new URL("../src/components/ReportsView.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "report-refresh-test" });
const template = compileTemplate({
  source: descriptor.template.content,
  filename: "ReportsView.vue",
  id: "report-refresh-test",
  compilerOptions: { bindingMetadata: script.bindings },
});
assert.deepEqual(template.errors, []);

function replaceImports(code) {
  return code.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g, (_, binding, name) =>
    binding.trim().startsWith("{")
      ? `const ${binding.replace(/(\w+)\s+as\s+(\w+)/g, "$1: $2")} = modules[${JSON.stringify(name)}];`
      : `const ${binding} = modules[${JSON.stringify(name)}].default;`);
}

const compiled = replaceImports(script.content).replace("export default", "module.exports =");
const compiledTemplate = replaceImports(template.code)
  .replace("export function render", "module.exports.render = function render");
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

async function fixture(t, fetchReports = async () => result(), overrides = {}, instant = "2026-10-29T10:00:00+08:00") {
  let now = new Date(instant);
  const calls = [];
  const requests = [];
  const downloads = [];
  const timers = new Map();
  let timerId = 0;
  const icon = { render: () => null };
  const modules = {
    vue,
    "lucide-vue-next": Object.fromEntries(
      ["ArrowDownToLine", "RefreshCw", "Image", "ClipboardCopy", "FileSearch", "TriangleAlert"].map((name) => [name, icon])),
    "../api.js": {
      localDate: () => "2026-10-29",
      showValue: (value) => value ?? "-",
      saveBlob: (blob, filename) => downloads.push({ blob, filename }),
      request: async (url, options) => {
        requests.push({ url, ...options });
        if (url === "/reports/export") return {
          headers: new Headers({ "Content-Disposition": 'attachment; filename="reports.xlsx"' }),
          blob: async () => new Blob(["test workbook"]),
        };
        if (!url.startsWith("/reports?")) return {};
        calls.push(url);
        return fetchReports(calls.length);
      },
    },
    "../../../../packages/core/src/current-shift.js": { currentShift: () => currentShift(now) },
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
    setInterval: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearInterval: (id) => timers.delete(id), setTimeout, clearTimeout, queueMicrotask,
    fetch: async () => ({}),
  };
  vm.runInNewContext(compiled, context);
  vm.runInNewContext(compiledTemplate, context);
  const props = vue.reactive({
    today: "2026-10-29", refreshKey: 0, online: true, active: true, cacheScope: "test",
    transientReports: false, dataRoot: "/reports", deploymentMode: "client",
    scanStatus: { scanning: false, reportCount: 1 },
    ...overrides,
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
  function html() {
    return renderToString(vue.createSSRApp({
      render() {
        return context.module.exports.render({}, [], props, vue.proxyRefs(state));
      },
    }));
  }
  return {
    state, props, calls, requests, downloads, html,
    document: context.document,
    setNow: (instant) => { now = new Date(instant); },
    runTimers: () => { for (const callback of timers.values()) callback(); },
  };
}

test("background status and unrelated revisions preserve the displayed report objects", async (t) => {
  const { state, props, calls } = await fixture(t, async (n) => result({ revision: n }));
  const reports = state.reports.value;
  props.scanStatus.scanning = true;
  await tick();
  props.scanStatus.scanning = false;
  await tick();
  assert.equal(calls.length, 1, "routine scans with a ready page do not query again");
  props.refreshKey++;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(state.reports.value, reports);
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
  }, { deploymentMode: "server" });
  props.refreshKey++;
  await tick();
  assert.equal(state.activeSheet.value.rows[0][0], 17);
  assert.equal(state.activeSheet.value.summary.average[0], 17);
});

test("the client renders only the detail table and daily report controls", async (t) => {
  const { state, html } = await fixture(t);
  assert.equal(state.recordMode.value, false);
  assert.equal(state.recordSheets.value.length, 0);
  const page = await html();
  assert.match(page, /class="sample-cell"/);
  assert.match(page, /显示明细列/);
  assert.match(page, /导出全部 Excel/);
  assert.doesNotMatch(page, /报告视图|记录表|更多操作与信息|生成全部图片|昨日完整报告|选择整个班次/);
  assert.doesNotMatch(page, /class="record-table-wrap"|class="report-options"/);
});

test("the center keeps record sheets, view switching and extended operations", async (t) => {
  const { state, props, html } = await fixture(t, async (n) => result({ revision: n }), {
    deploymentMode: "server",
  });
  assert.equal(state.recordMode.value, true);
  const sheet = state.activeSheet.value;
  assert.match(await html(), /class="record-table-wrap"/);
  assert.match(await html(), /更多操作与信息/);
  props.refreshKey++;
  await tick();
  assert.equal(state.activeSheet.value, sheet);
  state.viewMode.value = "list";
  assert.match(await html(), /class="sample-cell"/);
  assert.match(await html(), /报告视图/);
});

test("the client does not restore a hidden aggregate filter from old settings", async (t) => {
  const initialQuery = { date: "2026-10-29", shift: "day", excludeAggregate: true };
  const client = await fixture(t, undefined, { initialQuery });
  assert.equal(client.state.query.excludeAggregate, false);
  assert.match(client.calls[0], /excludeAggregate=false/);
  const center = await fixture(t, undefined, { initialQuery, deploymentMode: "server" });
  assert.equal(center.state.query.excludeAggregate, true);
});

test("client Excel exports use the detail format for all and selected reports", async (t) => {
  const { state, requests, downloads } = await fixture(t);
  await state.exportReports();
  state.toggle("a".repeat(32));
  await state.exportReports(true);
  const exports = requests.filter((entry) => entry.url === "/reports/export");
  assert.equal(exports.length, 2);
  assert.equal(exports[0].method, "POST");
  assert.equal(exports[0].body.view, undefined);
  assert.equal(exports[0].body.excludeAggregate, true);
  assert.equal(exports[1].body.view, undefined);
  assert.deepEqual(Array.from(exports[1].body.ids), ["a".repeat(32)]);
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].filename, "reports.xlsx");
});

test("center record Excel exports retain their existing format", async (t) => {
  const { state, requests } = await fixture(t, undefined, { deploymentMode: "server" });
  await state.exportReports();
  assert.equal(requests.find((entry) => entry.url === "/reports/export").body.view, "record");
});

test("the client can clear selections without an extended menu", async (t) => {
  const { state, html } = await fixture(t);
  state.toggle("a".repeat(32));
  state.toggle("b".repeat(32));
  assert.match(await html(), /清除选择/);
  assert.match(await html(), /导出选中 Excel/);
  state.clearSelection();
  assert.equal(state.selectionCount.value, 0);
  assert.doesNotMatch(await html(), /清除选择/);
  assert.match(await html(), /导出全部 Excel/);
});

test("offline client reports stay readable without unavailable image controls", async (t) => {
  const { state, props, html } = await fixture(t);
  const reports = state.reports.value;
  props.online = false;
  await tick();
  assert.equal(state.reports.value, reports);
  const page = await html();
  assert.match(page, /离线查看缓存，Excel 导出需联网/);
  assert.match(page, /class="sample-cell"/);
  assert.doesNotMatch(page, /图片|更多操作与信息|记录表/);
});

test("real changed measurements reach the client's visible detail columns", async (t) => {
  const { state, props, html } = await fixture(t, async (n) => {
    const next = result({ revision: n });
    next.reports[0].testResults[0].gram = n === 1 ? 30 : 17;
    return next;
  });
  state.showDetails.value = true;
  props.refreshKey++;
  await tick();
  assert.equal(state.reports.value[0].testResults[0].gram, 17);
  assert.match(await html(), /class="measurement-cell"[^>]*>(?:\s|<!--[^>]*-->)*17/);
});

test("new client reports return a historical query to the current shift once", async (t) => {
  const { state, props, calls, html } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-20", shift: "night" },
  });
  state.toggle("a".repeat(32));
  assert.match(await html(), /非当前班次/);
  props.scanStatus.reportCount = 2;
  props.refreshKey++;
  await tick();
  assert.equal(state.query.date, "2026-10-29");
  assert.equal(state.query.shift, "day");
  assert.equal(state.query.page, 1);
  assert.equal(state.selectionCount.value, 0);
  assert.equal(calls.length, 2, "the new-report status and revision share one query");
  assert.doesNotMatch(await html(), /非当前班次/);
  assert.match(await html(), /收到新报告，已返回当前班次/);
});

test("new reports already in the current shift update silently", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { state, props, calls } = await fixture(t, async (n) => {
    if (n === 2) await gate;
    return result({ revision: n });
  });
  const reports = state.reports.value;
  props.scanStatus.reportCount = 2;
  props.refreshKey++;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(state.loading.value, false);
  assert.equal(state.reports.value, reports);
  release();
  await tick();
  assert.equal(calls.length, 2);
});

test("initial status, routine scans and edits do not interrupt historical queries", async (t) => {
  const { state, props, calls } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-20", shift: "night" },
    scanStatus: { scanning: false },
  });
  props.scanStatus.reportCount = 100;
  await tick();
  assert.equal(calls.length, 1);
  props.scanStatus.scanning = true;
  await tick();
  props.scanStatus.scanning = false;
  props.refreshKey++;
  await tick();
  assert.equal(state.query.date, "2026-10-20");
  assert.equal(state.query.shift, "night");
  assert.equal(calls.length, 2);
});

test("a center report-count change never switches its manual query", async (t) => {
  const { state, props, html } = await fixture(t, undefined, {
    deploymentMode: "server", initialQuery: { date: "2026-10-20", shift: "day" },
  });
  props.scanStatus.reportCount = 2;
  props.refreshKey++;
  await tick();
  assert.equal(state.query.date, "2026-10-20");
  assert.doesNotMatch(await html(), /非当前班次|current-shift-badge/);
});

test("the client defaults to the correct current night shift before 07:00", async (t) => {
  const { state, html } = await fixture(t, undefined, {}, "2026-10-30T06:59:59+08:00");
  assert.equal(state.query.date, "2026-10-29");
  assert.equal(state.query.shift, "night");
  assert.equal(state.isCurrentShift.value, true);
  assert.match(await html(), /current-shift-badge/);
  assert.doesNotMatch(await html(), /非当前班次/);
});

test("the shift boundary changes the warning without switching a manual query", async (t) => {
  const { state, setNow, runTimers, html } = await fixture(t, undefined, {}, "2026-10-29T18:59:59+08:00");
  assert.equal(state.isCurrentShift.value, true);
  setNow("2026-10-29T19:00:00+08:00");
  runTimers();
  await tick();
  assert.equal(state.query.shift, "day");
  assert.equal(state.productionShift.value.shift, "night");
  const page = await html();
  assert.match(page, /reports-page--history/);
  assert.match(page, /非当前班次 · 2026-10-29 白班/);
  assert.match(page, /当前班次：2026-10-29 夜班/);
  state.chooseCurrentShift();
  await tick();
  assert.equal(state.query.shift, "night");
  assert.doesNotMatch(await html(), /非当前班次/);
});

test("an all-day client query is visibly distinct from the current shift", async (t) => {
  const { state, html } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-29", shift: "full" },
  });
  assert.equal(state.isCurrentShift.value, false);
  assert.match(await html(), /非当前班次 · 2026-10-29 全天/);
  assert.match(await html(), /返回当前班次/);
});

test("new-report navigation waits for editing or exporting to finish", async (t) => {
  for (const action of ["edit", "export"]) {
    const { state, props } = await fixture(t, undefined, {
      initialQuery: { date: "2026-10-20", shift: "day" },
    });
    if (action === "edit") state.startEdit(state.reports.value[0], "sampleName", null, "4 sample");
    else state.actionBusy.value = "export";
    props.scanStatus.reportCount = 2;
    props.refreshKey++;
    await tick();
    assert.equal(state.query.date, "2026-10-20", action);
    if (action === "edit") state.cancelEdit();
    else state.actionBusy.value = "";
    await tick();
    assert.equal(state.query.date, "2026-10-29", action);
  }
});

test("new-report navigation waits until the report page is visible", async (t) => {
  const { state, props, document } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-20", shift: "night" }, active: false,
  });
  props.scanStatus.reportCount = 2;
  await tick();
  assert.equal(state.query.date, "2026-10-20");
  props.active = true;
  await tick();
  assert.equal(state.query.date, "2026-10-29");
  state.query.date = "2026-10-20";
  await tick();
  document.visibilityState = "hidden";
  props.scanStatus.reportCount = 3;
  await tick();
  assert.equal(state.query.date, "2026-10-20");
  document.visibilityState = "visible";
  state.resume();
  await tick();
  assert.equal(state.query.date, "2026-10-29");
});

test("acquisition triggers a return even when the net report count stays unchanged", async (t) => {
  const { state, props, calls } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-20", shift: "night" },
    scanStatus: { scanning: false, reportCount: 5, reportDataRevision: 10 },
  });
  props.scanStatus.reportDataRevision = 11;
  props.refreshKey++;
  await tick();
  assert.equal(state.query.date, "2026-10-29");
  assert.equal(state.query.shift, "day");
  assert.equal(calls.length, 2);
});

test("known acquisition markers prevent count-only changes from causing a return", async (t) => {
  const { state, props } = await fixture(t, undefined, {
    initialQuery: { date: "2026-10-20", shift: "night" },
    scanStatus: { scanning: false, reportCount: 5, reportDataRevision: 10 },
  });
  props.scanStatus.reportCount = 6;
  props.refreshKey++;
  await tick();
  assert.equal(state.query.date, "2026-10-20");
  assert.equal(state.query.shift, "night");
});
