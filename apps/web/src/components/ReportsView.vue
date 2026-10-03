<script setup>
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import {
  ArrowDownToLine,
  RefreshCw,
  Image,
  ClipboardCopy,
  FileSearch,
} from "lucide-vue-next";
import { localDate, request, saveBlob, showValue } from "../api.js";
import { readReportPage, saveReportPage, pageKey } from "../offline-cache.js";
import { createReportImages } from "../report-images.js";
import Modal from "./Modal.vue";
import ReportDetail from "./ReportDetail.vue";
const props = defineProps({
  today: String,
  refreshKey: Number,
  live: Boolean,
  online: Boolean,
  active: Boolean,
  cacheScope: String,
  transientReports: Boolean,
  dataRoot: String,
  initialQuery: Object,
  scanStatus: Object,
  deploymentMode: String,
});
const clientId = crypto.randomUUID();
function requestQuery(snapshot) {
  return { ...snapshot, clientId };
}
const emit = defineEmits(["query-changed"]);
const query = reactive({
  date: props.initialQuery?.date || props.today || localDate(),
  shift: props.initialQuery?.shift || "day",
  excludeAggregate: Boolean(props.initialQuery?.excludeAggregate),
  page: props.initialQuery?.page || 1,
  pageSize: 100,
});
const reports = ref([]);
const total = ref(0);
const indexing = ref(false);
const selected = ref(new Set());
const wholeQuery = ref(false);
const selectionCount = computed(() =>
  wholeQuery.value ? total.value : selected.value.size,
);
const hasSelection = computed(
  () => wholeQuery.value || selected.value.size > 0,
);
const loading = ref(false);
const error = ref("");
const sourceWarnings = ref([]);
const sources = ref([]);
const transient = ref(false);
const cacheAllowed = computed(
  () => !props.transientReports && !transient.value,
);
const actionError = ref("");
const notice = ref("");
const cached = ref(false);
const detail = ref(null);
const actionBusy = ref("");
const actionProgress = ref("");
const images = ref([]);
const imageOpen = ref(false);
const loadedQuery = ref(null);
const loadedAt = ref("");
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / query.pageSize)),
);
let controller,
  imageController,
  exportController,
  leaseTimer,
  leaseScope = "",
  activeKey = "",
  sequence = 0,
  pendingRefresh = false;
const shiftNames = { day: "白班", night: "夜班", full: "完整班次" };
const sourceStates = { local: "本机", ready: "最近在线", syncing: "待补传", offline: "离线", error: "上传异常", revoked: "已撤销", stale: "缓存已过期" };
const timeRange = computed(
  () =>
    ({
      day: "07:00 – 19:00",
      night: "19:00 – 次日 07:00",
      full: "07:00 – 次日 07:00",
    })[query.shift],
);
const queryDirectories = computed(() => {
  if (!props.dataRoot || !query.date) return [];
  const root = props.dataRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const dates = [query.date];
  if (query.shift !== "day") {
    const next = new Date(`${query.date}T12:00:00Z`);
    if (Number.isFinite(next.getTime())) {
      next.setUTCDate(next.getUTCDate() + 1);
      dates.push(next.toISOString().slice(0, 10));
    }
  }
  return dates.map((date) => `${root}/${date}`);
});
const scanErrors = computed(() => {
  const root = props.dataRoot?.replaceAll("\\", "/").replace(/\/$/, "");
  return (props.scanStatus?.errors || [])
    .filter((item) => {
      const file = item.path.replaceAll("\\", "/").replace(/\/$/, "");
      return (
        file === root ||
        queryDirectories.value.some(
          (directory) => file === directory || file.startsWith(`${directory}/`),
        )
      );
    })
    .slice(0, 3);
});
const emptyState = computed(() => {
  if (!props.online && props.transientReports)
    return {
      title: "局域网汇总页面已断线",
      description:
        "当前结果只保留在内存中，连接恢复后才能继续获取报告；不会把断线状态当成零份报告。",
    };
  if (!props.online)
    return {
      title: "此缓存页中没有报告",
      description: "这不代表服务端没有报告。请联网更新，或选择其他已缓存查询。",
    };
  if (indexing.value)
    return {
      title: "正在准备当前日期报告",
      description: "已启动按需读取；无需等待全部完成，入库后会自动显示。",
    };
  if (scanErrors.value.length)
    return {
      title: "报告读取存在问题",
      description: "请查看上方读取错误，核对报告格式和目录读取权限。",
    };
  return {
    title: "这个班次还没有报告",
    description: "试试其他日期或班次。新报告到达后会自动更新。",
  };
});
function isSelected(id) {
  return wholeQuery.value || selected.value.has(id);
}
const allSelected = computed(
  () =>
    reports.value.length > 0 &&
    reports.value.every((report) => isSelected(report.id)),
);
const testsCount = computed(() =>
  Math.max(
    20,
    ...reports.value.map((report) => report.testResults?.length || 0),
  ),
);
const readyForActions = computed(() =>
  Boolean(loadedQuery.value && total.value > 0 && !indexing.value),
);
function displayResult(result, snapshot, savedAt, fromCache) {
  reports.value = result.reports;
  transient.value = Boolean(props.transientReports || result.transient);
  sources.value = result.sources || [];
  sourceWarnings.value = result.warnings || [];
  total.value = result.total;
  indexing.value = Boolean(result.indexing);
  loadedQuery.value = snapshot;
  cached.value = fromCache;
  loadedAt.value = new Date(savedAt).toLocaleString("zh-CN");
  if (detail.value)
    detail.value =
      result.reports.find((report) => report.id === detail.value.id) || null;
}
function leasePayload(snapshot, release = false) {
  return {
    clientId,
    date: snapshot?.date || query.date,
    shift: snapshot?.shift || query.shift,
    excludeAggregate: Boolean(
      snapshot?.excludeAggregate ?? query.excludeAggregate,
    ),
    ...(release ? { release: true } : {}),
  };
}
async function touchLease() {
  if (
    props.deploymentMode === "server" ||
    !props.online ||
    !props.active ||
    document.visibilityState !== "visible"
  )
    return;
  const snapshot = loadedQuery.value || query;
  if (!snapshot?.date || !snapshot?.shift) return;
  const nextScope = JSON.stringify(leasePayload(snapshot));
  try {
    await request("/reports/lease", {
      method: "POST",
      body: leasePayload(snapshot),
      retries: 0,
      timeout: 8_000,
    });
    leaseScope = nextScope;
  } catch {
    /* A lease is advisory; report loading remains usable when it cannot be renewed. */
  }
}
function scheduleLease() {
  clearInterval(leaseTimer);
  leaseTimer = null;
  if (
    props.deploymentMode !== "server" &&
    props.online &&
    props.active &&
    document.visibilityState === "visible"
  ) {
    touchLease();
    leaseTimer = setInterval(touchLease, 30_000);
  }
}
async function releaseLease() {
  clearInterval(leaseTimer);
  leaseTimer = null;
  if (!leaseScope) return;
  const payload = leasePayload(loadedQuery.value || query, true);
  leaseScope = "";
  try {
    await fetch("/api/reports/release", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Lizi-Request": "1" },
      body: JSON.stringify({ clientId: payload.clientId }),
      keepalive: true,
    });
  } catch {
    /* Pagehide/unmount cannot safely retry a release. */
  }
}
async function loadReports() {
  const snapshot = { ...query };
  const key = pageKey(snapshot);
  if (loading.value && activeKey === key) {
    pendingRefresh = true;
    return;
  }
  if (key !== activeKey) {
    controller?.abort();
    reports.value = [];
    loadedQuery.value = null;
    detail.value = null;
    loadedAt.value = "";
    transient.value = Boolean(props.transientReports);
    sourceWarnings.value = [];
    sources.value = [];
    error.value = "";
  }
  activeKey = key;
  const current = ++sequence;
  pendingRefresh = false;
  if (!snapshot.date) {
    loading.value = false;
    error.value = "请选择报告日期。";
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  error.value = "";
  try {
    if (!loadedQuery.value && cacheAllowed.value) {
      const saved = await readReportPage(props.cacheScope, snapshot);
      if (current !== sequence) return;
      if (saved) displayResult(saved.data, snapshot, saved.savedAt, true);
    }
    if (!props.online) {
      cached.value = Boolean(loadedQuery.value);
      if (!loadedQuery.value)
        error.value =
          "此查询页尚未缓存，离线时不可用。请联网，或返回此前已查看的日期和页码。";
      return;
    }
    if (!props.active || document.visibilityState !== "visible") {
      pendingRefresh = true;
      return;
    }
    const result = await request(
      `/reports?${new URLSearchParams(requestQuery(snapshot))}`,
      {
        signal,
      },
    );
    if (current !== sequence) return;
    if (result.root !== props.dataRoot) {
      window.dispatchEvent(new Event("lizi:data-root-changed"));
      return;
    }
    displayResult(result, snapshot, Date.now(), false);
    scheduleLease();
    if (snapshot.page > pageCount.value && !result.indexing) {
      query.page = pageCount.value;
      return;
    }
    if (cacheAllowed.value)
      await saveReportPage(props.cacheScope, snapshot, result);
  } catch (cause) {
    if (current === sequence && cause.name !== "AbortError")
      error.value = cause.message;
  } finally {
    if (current === sequence) {
      loading.value = false;
      if (
        pendingRefresh &&
        props.online &&
        props.active &&
        document.visibilityState === "visible"
      ) {
        pendingRefresh = false;
        queueMicrotask(loadReports);
      }
    }
  }
}
function clearSelection() {
  selected.value = new Set();
  wholeQuery.value = false;
}
watch(
  () => [query.date, query.shift, query.excludeAggregate],
  () => {
    query.page = 1;
    clearSelection();
    imageController?.abort();
    releaseImages();
    imageOpen.value = false;
    notice.value = "";
    actionError.value = "";
    loadedQuery.value = null;
    releaseLease().finally(scheduleLease);
  },
  { flush: "sync" },
);
watch(
  () => pageKey(query),
  () => {
    emit("query-changed", { ...query });
    loadReports();
  },
  { immediate: true },
);
watch(
  () => [props.refreshKey, props.online],
  () => {
    if (props.active && document.visibilityState === "visible") loadReports();
    else pendingRefresh = true;
  },
);
watch(
  () => props.active,
  (active) => {
    if (active && pendingRefresh) loadReports();
    if (active) scheduleLease();
    else releaseLease();
  },
);
function resume() {
  if (document.visibilityState === "visible") {
    scheduleLease();
    if (props.active && pendingRefresh) loadReports();
  } else releaseLease();
}
document.addEventListener("visibilitychange", resume);
window.addEventListener("pagehide", releaseLease);
function toggle(id) {
  if (wholeQuery.value) return;
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else if (next.size >= 20_000) {
    actionError.value =
      "逐项选择最多 20000 份。导出整个班次请使用“选择整个班次”。";
    return;
  } else next.add(id);
  selected.value = next;
}
function toggleAll() {
  if (wholeQuery.value) {
    clearSelection();
    return;
  }
  const next = new Set(selected.value);
  if (allSelected.value)
    reports.value.forEach((report) => next.delete(report.id));
  else reports.value.forEach((report) => next.add(report.id));
  if (next.size > 20_000) {
    actionError.value = "逐项选择最多 20000 份，请改用“选择整个班次”。";
    return;
  }
  selected.value = next;
}
function chooseWholeQuery() {
  selected.value = new Set();
  wholeQuery.value = true;
}
function yesterday() {
  const day = new Date(`${props.today || localDate()}T12:00:00`);
  day.setDate(day.getDate() - 1);
  const date = localDate(day);
  if (query.date === date && query.shift === "full" && query.excludeAggregate)
    loadReports();
  else Object.assign(query, { date, shift: "full", excludeAggregate: true });
}
async function exportReports(onlySelected = false) {
  if (
    !props.online ||
    !readyForActions.value ||
    actionBusy.value ||
    (onlySelected && !hasSelection.value)
  )
    return;
  actionBusy.value = "export";
  actionError.value = "";
  notice.value = "";
  const { date, shift, excludeAggregate } = loadedQuery.value;
  const snapshot = {
    date,
    shift,
    excludeAggregate: onlySelected ? excludeAggregate : true,
  };
  if (onlySelected) {
    if (wholeQuery.value) snapshot.allSelected = true;
    else snapshot.ids = [...selected.value];
  }
  exportController = new AbortController();
  try {
    const response = await request("/reports/export", {
      method: "POST",
      body: snapshot,
      binary: true,
      timeout: 180_000,
      signal: exportController.signal,
    });
    const disposition = response.headers.get("Content-Disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="([^"]+)"/i);
    let filename = `${snapshot.date}-${shiftNames[snapshot.shift]}-粒子报告.xlsx`;
    if (encoded) {
      try {
        filename = decodeURIComponent(encoded[1]);
      } catch {
        /* Keep the safe fallback filename. */
      }
    } else if (plain) filename = plain[1];
    saveBlob(await response.blob(), filename);
    notice.value = "Excel 已生成，正在下载。";
  } catch (cause) {
    actionError.value = cause.message;
  } finally {
    actionBusy.value = "";
  }
}
function releaseImages() {
  images.value.forEach((image) => URL.revokeObjectURL(image.url));
  images.value = [];
}
async function* imageReports(snapshot, chosen, entire, signal) {
  const remaining = new Set(chosen);
  const explicit = entire || remaining.size > 0;
  let revision,
    pages = 1,
    generated = 0;
  for (let page = 1; page <= pages; page++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const params = {
      ...snapshot,
      page,
      pageSize: 100,
      excludeAggregate: explicit ? snapshot.excludeAggregate : true,
    };
    let result;
    if (props.online)
      result = await request(
        `/reports?${new URLSearchParams(requestQuery(params))}`,
        {
          signal,
        },
      );
    else {
      if (!cacheAllowed.value)
        throw new Error(
          "局域网汇总报告只保留在内存中，断线后不能生成离线图片；请连接本地服务后重试。",
        );
      const saved = await readReportPage(props.cacheScope, {
        ...params,
        excludeAggregate: snapshot.excludeAggregate,
      });
      result = saved.data;
    }
    if (result.indexing)
      throw new Error(
        "此页数据仍在准备，或缓存保存时尚未准备完成。请联网等待完成后生成完整图片。",
      );
    if (revision !== undefined && revision !== result.revision)
      throw new Error("报告在生成期间发生变化，请刷新后重试，避免跨页遗漏。");
    if (result.root !== props.dataRoot) {
      window.dispatchEvent(new Event("lizi:data-root-changed"));
      throw new Error("报告根目录已变化，请重新验证后生成图片。");
    }
    revision = result.revision;
    pages = Math.max(1, Math.ceil(result.total / 100));
    for (const report of result.reports) {
      if (
        entire ||
        (explicit ? remaining.has(report.id) : !report.isAggregate)
      ) {
        remaining.delete(report.id);
        generated++;
        yield report;
      }
    }
    actionProgress.value = `已读取 ${page} / ${pages} 页，已处理 ${generated} 份报告`;
    if (explicit && !entire && !remaining.size) break;
  }
  if (remaining.size)
    throw new Error(
      `有 ${remaining.size} 份已选报告不在当前查询中，请刷新并重新选择。`,
    );
  if (!generated) throw new Error("排除总分析后没有可生成图片的报告。");
}
async function generateImages() {
  if (!readyForActions.value || actionBusy.value) return;
  actionBusy.value = "image";
  actionError.value = "";
  notice.value = "";
  actionProgress.value = "正在按需读取报告…";
  imageController = new AbortController();
  const signal = imageController.signal;
  const snapshot = { ...loadedQuery.value };
  const title = `${snapshot.date} ${shiftNames[snapshot.shift]}`;
  try {
    releaseImages();
    images.value = await createReportImages(
      imageReports(snapshot, [...selected.value], wholeQuery.value, signal),
      title,
      { signal },
    );
    imageOpen.value = true;
  } catch (cause) {
    if (cause.name !== "AbortError") actionError.value = cause.message;
  } finally {
    actionBusy.value = "";
    actionProgress.value = "";
  }
}
async function copyImage(image) {
  actionError.value = "";
  notice.value = "";
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem)
      throw new Error("当前浏览器不支持复制图片，请下载或长按图片保存。");
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": image.blob }),
    ]);
    notice.value = "图片已复制，可以粘贴到聊天中。";
  } catch (cause) {
    actionError.value = cause.message || "复制失败，请下载或长按图片保存。";
  }
}
onUnmounted(() => {
  sequence++;
  controller?.abort();
  imageController?.abort();
  exportController?.abort();
  releaseLease();
  releaseImages();
  document.removeEventListener("visibilitychange", resume);
  window.removeEventListener("pagehide", releaseLease);
});
</script>

<template>
  <section class="reports-page reports-page--table-first">
    <h1 class="sr-only">强度报告</h1>
    <section class="query-panel" aria-label="报告筛选">
      <label class="date-field"
        >报告日期<input v-model="query.date" type="date" required
      /></label>
      <div class="shift-field">
        <span class="field-label">班次</span>
        <div class="segmented" aria-label="班次">
          <button
            v-for="(name, key) in shiftNames"
            :key="key"
            :class="{ active: query.shift === key }"
            :aria-pressed="query.shift === key"
            @click="query.shift = key"
          >
            {{ key === "full" ? "全天" : name }}
          </button>
        </div>
      </div>
      <button
        class="query-refresh"
        :aria-label="loading ? '查询中' : '刷新报告'"
        :disabled="loading"
        @click="loadReports()"
      >
        <RefreshCw :size="18" :class="{ spinning: loading }" /><span>{{
          loading ? "查询中" : "刷新"
        }}</span>
      </button>
    </section>
    <div class="results-toolbar">
      <div class="result-count">
        <strong>{{
          loadedQuery ? `${total} 份报告` : loading ? "查询中…" : "报告查询"
        }}</strong
        ><span class="muted">
          {{ hasSelection ? `已选 ${selectionCount} 份 · ` : "" }}{{ timeRange }}
          {{ query.excludeAggregate ? " · 已排除总分析" : "" }}
          <template v-if="loading"> · 更新中…</template>
          <template v-else-if="cached"> · 缓存</template>
        </span>
      </div>
      <button
        class="primary"
        :disabled="!online || !readyForActions || !!actionBusy"
        @click="exportReports(hasSelection)"
      >
        <ArrowDownToLine :size="18" />
        <template v-if="actionBusy === 'export'">正在导出…</template>
        <template v-else>{{ hasSelection ? "导出选中 Excel" : "导出全部 Excel" }}</template>
      </button>
    </div>
    <details class="report-options">
      <summary>更多操作与信息</summary>
      <div class="report-options-content">
        <div class="button-row">
          <button :disabled="!readyForActions || !!actionBusy" @click="generateImages">
            <Image :size="17" />
            <template v-if="actionBusy === 'image'">正在生成…</template>
            <template v-else>{{ hasSelection ? "生成选中图片" : "生成全部图片" }}</template>
          </button>
          <button @click="yesterday">昨日完整报告</button>
          <button :disabled="!reports.length || wholeQuery" @click="chooseWholeQuery">
            选择整个班次（{{ total }} 份）
          </button>
          <button :disabled="!hasSelection" @click="clearSelection">清除选择</button>
        </div>
        <label class="check-label">
          <input v-model="query.excludeAggregate" type="checkbox" />查询时排除总分析
        </label>
        <p class="field-help">
          逐项与本页选择会跨页保留。选择整个班次后，如需逐项调整，请先清除选择。
          导出全部和生成全部图片默认不含名称带“总”或“z”的总分析。若需包含，请关闭查询排除选项，再选择整个班次或逐项选择；选中项始终全部保留。排除总分析时按产线排序。
        </p>
        <p v-if="loadedAt" class="field-help">
          {{ cached || !online ? "缓存于" : "更新于" }} {{ loadedAt }}
        </p>
        <p v-if="transient" class="field-help">
          局域网汇总报告仅保留在本页面内存中，断线后显示的是最后一次已获取的结果；不会写入离线缓存。
        </p>
        <p v-if="sources.length" class="field-help report-sources">
          来源：<span v-for="(source, index) in sources" :key="source.id"
            >{{ index ? "、" : "" }}{{ source.name || source.id
            }}{{ source.state && source.state !== "online" ? `（${source.warning || sourceStates[source.state] || "暂时不可用"}）` : "" }}</span>
        </p>
        <p v-if="online && scanStatus?.scanProgress" class="field-help">
          已检查 {{ scanStatus.scanProgress.visited }} 个文件 · 已入库
          {{ scanStatus.scanProgress.indexed }} 份 · 无效 {{ scanStatus.scanProgress.invalid }} 个
        </p>
        <p v-if="online && deploymentMode !== 'server'" class="field-help">
          报告根目录：{{ dataRoot || "尚未设置，请先在设置中选择报告根目录" }}
          <template v-if="queryDirectories.length">
            <br />查找日期目录：{{ queryDirectories.join("、") }}
          </template>
        </p>
      </div>
    </details>
    <details v-if="sourceWarnings.length" class="report-alert-summary">
      <summary>{{ deploymentMode === "server" ? "仅含已上传数据，完整性未确认" : "来源数据可能不完整" }} · {{ sourceWarnings.length }} 项提示</summary>
      <div role="note">
        <p v-for="warning in sourceWarnings" :key="warning">{{ warning }}</p>
      </div>
    </details>
    <p v-if="online && (indexing || scanStatus?.scanning)" class="notice" role="status">
      数据准备中，当前结果可能不完整。
    </p>
    <details v-if="online && scanErrors.length" class="report-alert-summary">
      <summary>部分文件或目录读取失败，当前结果可能不完整</summary>
      <p v-for="item in scanErrors" :key="item.path + item.message">
        {{ item.path }}：{{ item.message }}
      </p>
    </details>
    <p v-if="!online" class="notice" role="status">
      {{ transientReports || transient ? "已断线，仅显示最后获取的结果；导出和图片需重新连接。" : "离线查看缓存，Excel 需联网；图片需所需查询页均已缓存。" }}
    </p>
    <p v-if="!online && indexing" class="notice">
      缓存数据尚未准备完成，可能不完整；请联网完成准备后再导出或生成图片。
    </p>
    <p v-if="error && reports.length" role="alert" class="error-message">
      更新未完成：{{ error }}。下方保留上次报告。
    </p>
    <div
      v-if="error && !reports.length"
      role="alert"
      class="state-panel error-state"
    >
      <h2>报告未能加载</h2>
      <p>{{ error }}</p>
      <button @click="loadReports()"><RefreshCw :size="18" />重新查询</button>
    </div>
    <div
      v-else-if="loading && !reports.length"
      class="skeleton-list"
      aria-label="正在加载报告"
      aria-busy="true"
    >
      <div v-for="index in 3" :key="index" class="skeleton-card">
        <i /><i /><i />
      </div>
    </div>
    <div v-else-if="!reports.length" class="state-panel">
      <FileSearch :size="38" />
      <h2>{{ emptyState.title }}</h2>
      <p>{{ emptyState.description }}</p>
      <p v-if="online && deploymentMode !== 'server' && !dataRoot" class="field-help">
        请先在设置中选择报告根目录。
      </p>
      <button @click="yesterday">查看昨日完整报告</button>
    </div>
    <template v-else>
      <div class="report-results view-table" :aria-busy="loading">
        <div
          class="full-table table-wrap"
          tabindex="0"
          aria-label="完整报告表格，可横向滚动"
        >
          <table>
            <thead>
              <tr>
                <th class="selection-column">
                  <label class="selection-tools check-label">
                    <input
                      type="checkbox"
                      :checked="allSelected"
                      :indeterminate="!wholeQuery && reports.some((report) => selected.has(report.id)) && !allSelected"
                      :aria-label="wholeQuery ? '取消整个班次选择' : allSelected ? '取消本页选择' : '选择本页'"
                      @change="toggleAll"
                    />本页
                  </label>
                </th>
                <th>日期</th>
                <th>时间</th>
                <th>产线</th>
                <th>样品</th>
                <th>来源 / 仪器</th>
                <th class="average-column">平均 / g</th>
                <th>最大 / g</th>
                <th>最小 / g</th>
                <th v-for="index in testsCount" :key="index">{{ index }}</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="report in reports"
                :key="report.id"
                :class="{ selected: isSelected(report.id) }"
              >
                <td>
                  <label class="check-target"
                    ><input
                      type="checkbox"
                      :checked="isSelected(report.id)"
                      :disabled="wholeQuery"
                      :aria-label="`选择 ${report.sampleName} ${report.time}`"
                      @change="toggle(report.id)"
                  /></label>
                </td>
                <td>{{ report.date }}</td>
                <td>{{ report.time }}</td>
                <td>{{ showValue(report.line) }}</td>
                <td class="sample-cell">
                  <span
                    v-if="report.isAggregate"
                    class="aggregate-dot"
                    title="总分析"
                  />{{ report.sampleName }}
                </td>
                <td>{{ report.sourceName || report.sourceId || "本机" }}<span v-if="report.instrumentId"> · {{ report.instrumentId }}</span></td>
                <td class="average-column">
                  {{ showValue(report.averageHardness) }}
                </td>
                <td>{{ showValue(report.maxHardness) }}</td>
                <td>{{ showValue(report.minHardness) }}</td>
                <td v-for="index in testsCount" :key="index">
                  {{ showValue(report.testResults?.[index - 1]?.gram) }}
                </td>
                <td>
                  <button class="text-button" @click="detail = report">
                    查看
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
    <div v-if="pageCount > 1 || query.page > 1" class="pagination" aria-label="报告分页">
      <button :disabled="query.page <= 1" @click="query.page--">上一页</button>
      <span>第 {{ query.page }} / {{ pageCount }} 页</span>
      <button :disabled="query.page >= pageCount" @click="query.page++">下一页</button>
    </div>
    <p v-if="actionProgress" class="notice" role="status">
      {{ actionProgress }}
      <button @click="imageController?.abort()">取消生成</button>
    </p>
    <p v-if="actionError && !imageOpen" role="alert" class="error-message">
      {{ actionError }}
    </p>
    <p v-if="notice && !imageOpen" role="status" class="success-message">
      {{ notice }}
    </p>
    <Modal
      v-if="detail"
      :title="`${detail.sampleName || '报告'} · ${detail.date} ${detail.time}`"
      wide
      @close="detail = null"
      ><ReportDetail :report="detail"
    /></Modal>
    <Modal v-if="imageOpen" title="报告图片" wide @close="imageOpen = false"
      ><p class="muted">
        手机可长按图片保存。较多报告或测量值会分成多张，所有数据均保留。
      </p>
      <p v-if="actionError" role="alert" class="error-message">
        {{ actionError }}
      </p>
      <p v-if="notice" role="status" class="success-message">{{ notice }}</p>
      <figure
        v-for="(image, index) in images"
        :key="image.url"
        class="generated-image"
      >
        <figcaption>
          第 {{ index + 1 }} / {{ images.length }} 张
          <div class="button-row">
            <button @click="copyImage(image)">
              <ClipboardCopy :size="18" />复制图片</button
            ><button @click="saveBlob(image.blob, image.name)">
              <ArrowDownToLine :size="18" />下载
            </button>
          </div>
        </figcaption>
        <img
          :src="image.url"
          :alt="`粒子强度报告图片，第 ${index + 1} 张`"
        /></figure
    ></Modal>
  </section>
</template>
