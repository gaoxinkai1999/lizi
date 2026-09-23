<script setup>
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import {
  ArrowDownToLine,
  RefreshCw,
  SlidersHorizontal,
  Image,
  ClipboardCopy,
  Check,
  ChevronRight,
  FileSearch,
  X,
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
  dataRoot: String,
  initialQuery: Object,
  scanStatus: Object,
});
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
const actionError = ref("");
const notice = ref("");
const cached = ref(false);
const mode = ref("auto");
const mobileViewport = window.matchMedia("(max-width: 700px)");
const isMobile = ref(mobileViewport.matches);
const effectiveMode = computed(() =>
  mode.value === "auto" ? (isMobile.value ? "cards" : "table") : mode.value,
);
const openDetails = ref(new Set());
function updateViewport(event) {
  isMobile.value = event.matches;
}
mobileViewport.addEventListener("change", updateViewport);
const optionsOpen = ref(false);
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
  activeKey = "",
  sequence = 0,
  pendingRefresh = false;
const shiftNames = { day: "白班", night: "夜班", full: "完整班次" };
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
const simpleReports = computed(() =>
  selected.value.size && !wholeQuery.value
    ? reports.value.filter((report) => selected.value.has(report.id))
    : reports.value,
);
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
  total.value = result.total;
  indexing.value = Boolean(result.indexing);
  loadedQuery.value = snapshot;
  cached.value = fromCache;
  loadedAt.value = new Date(savedAt).toLocaleString("zh-CN");
  if (detail.value)
    detail.value =
      result.reports.find((report) => report.id === detail.value.id) || null;
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
    openDetails.value = new Set();
    detail.value = null;
    loadedAt.value = "";
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
    if (!loadedQuery.value) {
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
    const result = await request(`/reports?${new URLSearchParams(snapshot)}`, {
      signal,
    });
    if (current !== sequence) return;
    if (result.root !== props.dataRoot) {
      window.dispatchEvent(new Event("lizi:data-root-changed"));
      return;
    }
    displayResult(result, snapshot, Date.now(), false);
    if (snapshot.page > pageCount.value && !result.indexing) {
      query.page = pageCount.value;
      return;
    }
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
  },
);
function resume() {
  if (document.visibilityState === "visible" && props.active && pendingRefresh)
    loadReports();
}
document.addEventListener("visibilitychange", resume);
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
      result = await request(`/reports?${new URLSearchParams(params)}`, {
        signal,
      });
    else {
      // Offline selection uses exactly the cached query, filtering aggregates locally.
      const saved = await readReportPage(props.cacheScope, {
        ...params,
        excludeAggregate: snapshot.excludeAggregate,
      });
      if (!saved)
        throw new Error(
          `第 ${page} 页未缓存，无法生成完整图片。请联网后重试。`,
        );
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
  releaseImages();
  mobileViewport.removeEventListener("change", updateViewport);
  document.removeEventListener("visibilitychange", resume);
});
</script>

<template>
  <section class="reports-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">REPORTS</p>
        <h1>强度报告</h1>
        <p class="muted heading-description">从每一粒样品，了解生产质量。</p>
      </div>
      <button class="subtle yesterday-button" @click="yesterday">
        昨日完整<ChevronRight :size="17" />
      </button>
    </div>
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
    <div class="query-caption">
      <span
        >{{ timeRange
        }}<span v-if="query.excludeAggregate">
          · 已排除总分析 · 按产线排序</span
        ></span
      ><button
        class="text-button"
        :aria-expanded="optionsOpen"
        @click="optionsOpen = !optionsOpen"
      >
        <SlidersHorizontal :size="16" />更多选项
      </button>
    </div>
    <section v-if="optionsOpen" class="options-panel">
      <label class="check-label"
        ><input
          v-model="query.excludeAggregate"
          type="checkbox"
        />查询时排除总分析</label
      >
      <p class="field-help">
        导出全部和生成全部图片默认不含名称带“总”或“z”的总分析。若需包含，请关闭查询排除选项，全选后使用“导出选中”或“图片”。选中项始终全部保留。
      </p>
    </section>
    <div class="results-toolbar">
      <div class="result-count">
        <strong>{{
          loadedQuery ? `${total} 份报告` : loading ? "查询中…" : "报告查询"
        }}</strong
        ><span v-if="loadedAt" class="muted"
          >{{ cached || !online ? "缓存于" : "更新于" }} {{ loadedAt
          }}{{ loading ? " · 后台更新中…" : "" }}</span
        >
      </div>
      <label class="view-select"
        ><span class="sr-only">报告显示方式</span
        ><select v-model="mode">
          <option value="auto">自适应视图</option>
          <option value="cards">摘要卡片</option>
          <option value="table">完整表格</option>
          <option value="simple">简易模式</option>
        </select></label
      >
    </div>
    <p
      v-if="online && (indexing || scanStatus?.scanning)"
      class="notice"
      role="status"
    >
      正在准备所选日期数据，可先查看已入库报告。
      <template v-if="scanStatus?.scanProgress"
        >已检查 {{ scanStatus.scanProgress.visited }} 个文件 · 已入库
        {{ scanStatus.scanProgress.indexed }} 份 · 无效
        {{ scanStatus.scanProgress.invalid }} 个</template
      >
    </p>
    <div v-if="online && scanErrors.length" class="error-message" role="alert">
      <strong
        >所选日期有文件或目录未能读取，不能将当前数量视为完整结果。</strong
      >
      <p v-for="item in scanErrors" :key="item.path + item.message">
        {{ item.path }}：{{ item.message }}
      </p>
    </div>
    <p v-if="!online" class="notice">
      离线报告仅供查看；Excel 导出需联网。图片仅在所需查询页均已缓存时可生成。
    </p>
    <p v-if="!online && indexing" class="notice">
      此缓存保存时日期数据尚未准备完成，可能不完整；完整导出和图片需联网完成准备后再操作。
    </p>
    <p v-if="error && reports.length" role="alert" class="error-message">
      更新未完成：{{ error }}。下方保留上次报告。
    </p>
    <div
      v-if="loadedQuery || query.page > 1"
      class="pagination"
      aria-label="报告分页"
    >
      <button :disabled="query.page <= 1" @click="query.page--">上一页</button>
      <span>第 {{ query.page }} / {{ pageCount }} 页 · 每页最多 100 份</span>
      <button :disabled="query.page >= pageCount" @click="query.page++">
        下一页
      </button>
    </div>
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
      <p v-if="online" class="field-help">
        报告根目录：{{ dataRoot || "尚未设置，请先在设置中选择报告根目录" }}
        <template v-if="queryDirectories.length">
          <br />查找日期目录：{{ queryDirectories.join("、") }}
        </template>
      </p>
      <button @click="yesterday">查看昨日完整报告</button>
    </div>
    <template v-else>
      <div class="selection-tools">
        <label class="check-label"
          ><input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="
              !wholeQuery &&
              reports.some((report) => selected.has(report.id)) &&
              !allSelected
            "
            @change="toggleAll"
          />{{
            wholeQuery
              ? "取消整个班次选择"
              : allSelected
                ? "取消本页"
                : "选择本页"
          }}</label
        ><button @click="chooseWholeQuery" :disabled="wholeQuery">
          选择整个班次（{{ total }} 份）
        </button>
        <span class="muted"
          >{{
            hasSelection
              ? `已跨页选择 ${selectionCount} 份`
              : "逐项或本页选择会跨页保留"
          }}{{
            wholeQuery ? " · 如需逐项调整，请先取消整个班次选择" : ""
          }}</span
        >
      </div>
      <div
        class="report-results"
        :class="[
          `view-${effectiveMode}`,
          { 'is-loading': loading && !reports.length },
        ]"
        :aria-busy="loading"
      >
        <div v-if="effectiveMode === 'cards'" class="report-cards">
          <article
            v-for="report in reports"
            :key="report.id"
            class="report-card"
            :class="{ selected: isSelected(report.id) }"
          >
            <header>
              <label class="report-identity"
                ><span class="check-target"
                  ><input
                    type="checkbox"
                    :checked="isSelected(report.id)"
                    :disabled="wholeQuery"
                    :aria-label="`选择 ${report.sampleName} ${report.time}`"
                    @change="toggle(report.id)" /></span
                ><span
                  ><strong>{{ report.sampleName || "未命名样品" }}</strong
                  ><span class="report-time"
                    >{{ report.date }} · {{ report.time }}</span
                  ></span
                ></label
              ><span v-if="report.isAggregate" class="badge">总分析</span
              ><span
                v-else-if="report.line !== null && report.line !== undefined"
                class="line-badge"
                >{{ report.line }} 线</span
              >
            </header>
            <div class="hardness-summary">
              <div class="average">
                <span>平均硬度 <small>g</small></span
                ><strong>{{ showValue(report.averageHardness) }}</strong>
              </div>
              <div>
                <span>最大 <small>g</small></span
                ><strong>{{ showValue(report.maxHardness) }}</strong>
              </div>
              <div>
                <span>最小 <small>g</small></span
                ><strong>{{ showValue(report.minHardness) }}</strong>
              </div>
            </div>
            <details
              class="inline-detail"
              @toggle="
                $event.target.open
                  ? openDetails.add(report.id)
                  : openDetails.delete(report.id)
              "
            >
              <summary>
                详细测量<span
                  >{{ report.testResults?.length || 0 }} 次<ChevronRight
                    :size="16"
                /></span>
              </summary>
              <ReportDetail
                v-if="openDetails.has(report.id)"
                :report="report"
              />
            </details>
          </article>
        </div>
        <div
          v-if="effectiveMode === 'table'"
          class="full-table table-wrap"
          tabindex="0"
          aria-label="完整报告表格，可横向滚动"
        >
          <table>
            <thead>
              <tr>
                <th class="selection-column">选择</th>
                <th>日期</th>
                <th>时间</th>
                <th>产线</th>
                <th>样品</th>
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
        <div v-if="effectiveMode === 'simple'" class="simple-grid">
          <p v-if="!simpleReports.length" class="muted">
            本页没有已选报告；选择保留在其他页，可翻页查看或取消选择。
          </p>
          <article
            v-for="report in simpleReports"
            :key="report.id"
            class="simple-card"
          >
            <header>
              <div>
                <h3>
                  {{
                    report.line === null || report.line === undefined
                      ? report.sampleName
                      : `${report.line} 线`
                  }}
                </h3>
                <p>{{ report.sampleName }}</p>
                <time>{{ report.date }} {{ report.time }}</time>
              </div>
              <label class="check-target"
                ><input
                  type="checkbox"
                  :checked="isSelected(report.id)"
                  :disabled="wholeQuery"
                  :aria-label="`选择 ${report.sampleName}`"
                  @change="toggle(report.id)"
              /></label>
            </header>
            <div class="five-grid">
              <span
                v-for="(test, index) in report.testResults"
                :key="index"
                :title="`第 ${index + 1} 次 · g`"
                >{{ showValue(test.gram) }}</span
              >
            </div>
            <p v-if="!report.testResults?.length" class="muted">没有测量数据</p>
            <div class="simple-stats">
              <span
                >最大<strong>{{ showValue(report.maxHardness) }}</strong></span
              ><span class="accent"
                >平均<strong>{{
                  showValue(report.averageHardness)
                }}</strong></span
              ><span
                >最小<strong>{{ showValue(report.minHardness) }}</strong></span
              >
            </div>
            <button class="text-button" @click="detail = report">
              查看完整详情<ChevronRight :size="16" />
            </button>
          </article>
        </div>
      </div>
      <div v-if="!hasSelection" class="all-actions">
        <button
          class="primary"
          :disabled="!online || !readyForActions || !!actionBusy"
          @click="exportReports(false)"
        >
          <ArrowDownToLine :size="18" />{{
            actionBusy === "export" ? "正在导出…" : "导出全部 Excel"
          }}</button
        ><button
          :disabled="!readyForActions || !!actionBusy"
          @click="generateImages"
        >
          <Image :size="18" />{{
            actionBusy === "image" ? "正在生成…" : "生成图片"
          }}
        </button>
        <p class="field-help">覆盖整个查询，默认排除总分析。</p>
      </div>
    </template>
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
    <div v-if="hasSelection" class="selection-bar">
      <div class="selection-summary">
        <Check :size="18" /><strong>已选 {{ selectionCount }} 份</strong
        ><button
          class="icon-button"
          aria-label="取消全部选择"
          @click="clearSelection"
        >
          <X :size="17" />
        </button>
      </div>
      <div class="selection-actions">
        <button @click="mode = 'simple'">简易模式</button
        ><button
          :disabled="!readyForActions || !!actionBusy"
          @click="generateImages"
        >
          <Image :size="17" /><span>{{
            actionBusy === "image" ? "生成中…" : "图片"
          }}</span></button
        ><button
          class="primary"
          :disabled="!online || !readyForActions || !!actionBusy"
          @click="exportReports(true)"
        >
          <ArrowDownToLine :size="17" />{{
            actionBusy === "export" ? "导出中…" : "导出选中"
          }}
        </button>
      </div>
    </div>
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
