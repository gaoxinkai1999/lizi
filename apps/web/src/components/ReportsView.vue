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
import { createReportImages } from "../report-images.js";
import Modal from "./Modal.vue";
import ReportDetail from "./ReportDetail.vue";
const props = defineProps({ today: String, refreshKey: Number, live: Boolean });
const query = reactive({
  date: props.today || localDate(),
  shift: "day",
  excludeAggregate: false,
});
const reports = ref([]);
const selected = ref(new Set());
const loading = ref(false);
const error = ref("");
const actionError = ref("");
const notice = ref("");
const mode = ref("auto");
const mobileViewport = window.matchMedia("(max-width: 700px)");
const isMobile = ref(mobileViewport.matches);
const effectiveMode = computed(() => {
  if (mode.value !== "auto") return mode.value;
  return isMobile.value ? "cards" : "table";
});
const openDetails = ref(new Set());
function updateViewport(event) {
  isMobile.value = event.matches;
}
mobileViewport.addEventListener("change", updateViewport);
const optionsOpen = ref(false);
const detail = ref(null);
const actionBusy = ref("");
const images = ref([]);
const imageOpen = ref(false);
const loadedQuery = ref(null);
const loadedAt = ref("");
let controller,
  sequence = 0;
const shiftNames = { day: "白班", night: "夜班", full: "完整班次" };
const timeRange = computed(
  () =>
    ({
      day: "07:00 – 19:00",
      night: "19:00 – 次日 07:00",
      full: "07:00 – 次日 07:00",
    })[query.shift],
);
const chosenReports = computed(() =>
  reports.value.filter((report) => selected.value.has(report.id)),
);
const simpleReports = computed(() =>
  selected.value.size ? chosenReports.value : reports.value,
);
const allSelected = computed(
  () =>
    reports.value.length > 0 && selected.value.size === reports.value.length,
);
const totalExportable = computed(
  () => reports.value.filter((report) => !report.isAggregate).length,
);
const testsCount = computed(() =>
  Math.max(
    20,
    ...reports.value.map((report) => report.testResults?.length || 0),
  ),
);
const readyForActions = computed(
  () =>
    !loading.value &&
    !error.value &&
    loadedQuery.value &&
    reports.value.length > 0,
);
async function loadReports(reset = false) {
  controller?.abort();
  controller = new AbortController();
  const current = ++sequence;
  if (reset) {
    selected.value = new Set();
    openDetails.value = new Set();
    reports.value = [];
    loadedQuery.value = null;
  }
  if (!query.date) {
    loading.value = false;
    error.value = "请选择报告日期。";
    return;
  }
  const snapshot = { ...query };
  loading.value = true;
  error.value = "";
  try {
    const result = await request(`/reports?${new URLSearchParams(snapshot)}`, {
      signal: controller.signal,
    });
    if (current !== sequence) return;
    reports.value = result.reports;
    const available = new Set(result.reports.map((report) => report.id));
    selected.value = new Set(
      [...selected.value].filter((id) => available.has(id)),
    );
    loadedQuery.value = snapshot;
    loadedAt.value = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (detail.value)
      detail.value =
        result.reports.find((report) => report.id === detail.value.id) || null;
  } catch (cause) {
    if (current === sequence && cause.name !== "AbortError")
      error.value = cause.message;
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => [query.date, query.shift, query.excludeAggregate],
  () => loadReports(true),
  { immediate: true },
);
watch(
  () => props.refreshKey,
  () => loadReports(),
);
function toggle(id) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}
function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(reports.value.map((report) => report.id));
}
function yesterday() {
  const day = new Date(`${props.today || localDate()}T12:00:00`);
  day.setDate(day.getDate() - 1);
  const date = localDate(day);
  if (query.date === date && query.shift === "full" && query.excludeAggregate)
    loadReports(true);
  else Object.assign(query, { date, shift: "full", excludeAggregate: true });
}
async function exportReports(onlySelected = false) {
  if (!readyForActions.value || actionBusy.value) return;
  if (onlySelected && !selected.value.size) return;
  if (!onlySelected && !totalExportable.value) {
    actionError.value =
      "排除总分析后没有可导出的报告。如需保留总分析，请全选后导出选中项。";
    return;
  }
  actionBusy.value = "export";
  actionError.value = "";
  notice.value = "";
  const snapshot = { ...loadedQuery.value, excludeAggregate: !onlySelected };
  if (onlySelected) snapshot.ids = [...selected.value];
  try {
    const response = await request("/reports/export", {
      method: "POST",
      body: snapshot,
      binary: true,
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
async function generateImages() {
  if (!readyForActions.value || actionBusy.value) return;
  const source = selected.value.size
    ? chosenReports.value
    : reports.value.filter((report) => !report.isAggregate);
  if (!source.length) {
    actionError.value = "排除总分析后没有可生成图片的报告。";
    return;
  }
  actionBusy.value = "image";
  actionError.value = "";
  notice.value = "";
  const title = `${loadedQuery.value.date} ${shiftNames[loadedQuery.value.shift]}`;
  try {
    releaseImages();
    images.value = await createReportImages(source, title);
    imageOpen.value = true;
  } catch (cause) {
    actionError.value = cause.message;
  } finally {
    actionBusy.value = "";
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
  releaseImages();
  mobileViewport.removeEventListener("change", updateViewport);
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
        <strong>{{ loading ? "查询中…" : `${reports.length} 份报告` }}</strong
        ><span v-if="loadedAt && !loading" class="muted"
          >{{ loadedAt }} 更新</span
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
    <div v-if="error" role="alert" class="state-panel error-state">
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
      <h2>这个班次还没有报告</h2>
      <p>试试其他日期或班次。新报告到达后会自动更新。</p>
      <button @click="yesterday">查看昨日完整报告</button>
    </div>
    <template v-else>
      <div class="selection-tools">
        <label class="check-label"
          ><input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="selected.size > 0 && !allSelected"
            :disabled="loading"
            @change="toggleAll"
          />{{ allSelected ? "取消全选" : "全选" }}</label
        ><span class="muted">{{
          selected.size ? `已选 ${selected.size} 份` : "勾选报告可批量操作"
        }}</span>
      </div>
      <div
        class="report-results"
        :class="[`view-${mode}`, { 'is-loading': loading }]"
        :aria-busy="loading"
      >
        <div v-if="effectiveMode === 'cards'" class="report-cards">
          <article
            v-for="report in reports"
            :key="report.id"
            class="report-card"
            :class="{ selected: selected.has(report.id) }"
          >
            <header>
              <label class="report-identity"
                ><span class="check-target"
                  ><input
                    type="checkbox"
                    :checked="selected.has(report.id)"
                    :disabled="loading"
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
                :class="{ selected: selected.has(report.id) }"
              >
                <td>
                  <label class="check-target"
                    ><input
                      type="checkbox"
                      :checked="selected.has(report.id)"
                      :disabled="loading"
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
        <div v-if="mode === 'simple'" class="simple-grid">
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
                  :checked="selected.has(report.id)"
                  :disabled="loading"
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
      <div v-if="!selected.size" class="all-actions">
        <button
          class="primary"
          :disabled="!readyForActions || !!actionBusy"
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
        <p class="field-help">
          不含总分析 · 共
          {{ totalExportable }} 份；如需包含总分析，请全选后导出选中项。
        </p>
      </div>
    </template>
    <p v-if="actionError && !imageOpen" role="alert" class="error-message">
      {{ actionError }}
    </p>
    <p v-if="notice && !imageOpen" role="status" class="success-message">
      {{ notice }}
    </p>
    <div v-if="selected.size" class="selection-bar">
      <div class="selection-summary">
        <Check :size="18" /><strong>已选 {{ selected.size }} 份</strong
        ><button
          class="icon-button"
          aria-label="取消全部选择"
          @click="selected = new Set()"
        >
          <X :size="17" />
        </button>
      </div>
      <div class="selection-actions">
        <button :disabled="loading" @click="mode = 'simple'">简易模式</button
        ><button
          :disabled="!readyForActions || !!actionBusy"
          @click="generateImages"
        >
          <Image :size="17" /><span>{{
            actionBusy === "image" ? "生成中…" : "图片"
          }}</span></button
        ><button
          class="primary"
          :disabled="!readyForActions || !!actionBusy"
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
