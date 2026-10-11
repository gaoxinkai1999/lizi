<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { CloudUpload, RefreshCw } from "lucide-vue-next";
import { request } from "../api.js";

const props = defineProps({
  deploymentMode: String,
  user: Object,
  syncStatus: Object,
});
const emit = defineEmits(["refresh-status"]);

const server = computed(() => props.deploymentMode === "server");
const admin = computed(() => props.user?.role === "admin");
const canManage = ref(false);
const settings = ref(null);
const status = ref(null);
const types = ref([]);
const loading = ref(false);
const loaded = ref(false);
const stale = ref(false);
const busy = ref("");
const error = ref("");
const typesError = ref("");
const success = ref("");
const form = reactive({ instrumentId: "", instrumentType: "strength" });
const history = reactive({ from: "", to: "" });
const historyBusy = ref(false);
const historyNotice = ref("");
let timer;
let disposed = false;

const ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;

watch(
  () => props.syncStatus,
  (value) => {
    if (value) status.value = value;
  },
  { immediate: true },
);

const identityLocked = computed(() => Boolean(settings.value?.identityLocked));
const registration = computed(() => status.value?.registrationState || null);
const stateLabel = computed(() => {
  switch (registration.value) {
    case "revoked":
      return "停用";
    case "pending":
      return "待批准";
    case "approved":
      if (status.value?.connected === true) return "在线";
      if (status.value?.connected === false) return "断线";
      return "已批准";
    case "unconfigured":
      return "未配置";
    default:
      return "未知";
  }
});
const stateTone = computed(() => {
  switch (registration.value) {
    case "approved":
      return status.value?.connected === false ? "warn" : "good";
    case "pending":
      return "warn";
    case "revoked":
      return "bad";
    default:
      return "idle";
  }
});
const typeName = computed(
  () =>
    types.value.find((item) => item.id === form.instrumentType)?.name ||
    form.instrumentType,
);
const pendingCount = computed(() =>
  status.value?.queueMetricsStale
    ? "未知（存储异常）"
    : (status.value?.pending ?? "未知"),
);

function time(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无记录";
}

async function loadTypes() {
  try {
    const data = await request("/instrument-types", { retries: 0 });
    if (!Array.isArray(data?.types) || !data.types.length)
      throw new Error("服务未提供可用的仪器类型");
    if (disposed) return;
    types.value = data.types;
    typesError.value = "";
  } catch (cause) {
    if (!disposed) typesError.value = cause.message;
  }
}

async function load(refreshForm = false) {
  if (loading.value || server.value || disposed) return;
  loading.value = true;
  try {
    const data = await request("/sync", { retries: 0, localAdmin: true });
    if (disposed) return;
    status.value = data.status || status.value;
    canManage.value = Boolean(data.canManage && admin.value);
    if (data.settings && (!settings.value || refreshForm)) {
      settings.value = data.settings;
      form.instrumentId = data.settings.instrumentId || "";
      form.instrumentType = data.settings.instrumentType || "strength";
    }
    loaded.value = true;
    stale.value = false;
    error.value = "";
  } catch (cause) {
    if (disposed) return;
    error.value = cause.message;
    stale.value = true;
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (busy.value || !canManage.value || identityLocked.value || typesError.value || !types.value.length) return;
  const instrumentId = form.instrumentId.trim().toUpperCase();
  if (!ID_PATTERN.test(instrumentId)) {
    error.value =
      "仪器编号需为 1–24 位大写字母、数字、- 或 _，并以字母或数字开头。";
    return;
  }
  busy.value = "save";
  error.value = "";
  success.value = "";
  try {
    await request("/sync", {
      method: "PUT",
      body: { instrumentId, instrumentType: form.instrumentType },
      localAdmin: true,
    });
    success.value = `已保存并申请接入（编号 ${instrumentId}）。采集与上传随即启用；显示“待批准”时请让管理员在中心仪器页批准。`;
    await load(true);
    emit("refresh-status");
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function retry() {
  if (busy.value || !canManage.value) return;
  busy.value = "retry";
  error.value = "";
  try {
    await request("/sync/retry", { method: "POST", body: {}, localAdmin: true });
    await load();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}

async function backfill() {
  if (historyBusy.value || !canManage.value) return;
  historyBusy.value = true;
  historyNotice.value = "";
  try {
    await request("/sync/backfill", {
      method: "POST",
      body: { ...history },
      localAdmin: true,
    });
    historyNotice.value =
      "历史补传任务已安排，后台分批处理，重启后继续；不影响当天采集。";
    await load();
  } catch (cause) {
    historyNotice.value = `补传安排失败：${cause.message}`;
  } finally {
    historyBusy.value = false;
  }
}

onMounted(() => {
  loadTypes();
  load();
  timer = setInterval(() => {
    if (!busy.value && document.visibilityState === "visible") load();
  }, 30_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>

<template>
  <section v-if="!server" class="settings-section">
    <div class="section-heading">
      <CloudUpload :size="21" />
      <div>
        <h2>中心接入</h2>
        <p>填写仪器类型与编号并保存，即申请接入中心并开始采集与上传。</p>
      </div>
      <button
        class="icon-button"
        aria-label="刷新接入状态"
        :disabled="loading || !!busy"
        @click="load(true); loadTypes()"
      >
        <RefreshCw :size="18" :class="{ spinning: loading }" />
      </button>
    </div>
    <p v-if="error" class="error-message" role="alert">
      {{ error }}{{ stale ? "（下方为上次获取的数据，可能已过期）" : "" }}
    </p>
    <p v-if="typesError" class="error-message" role="alert">仪器类型读取失败：{{ typesError }}</p>
    <p v-if="success" class="success-message" role="status">{{ success }}</p>
    <p v-if="stale && loaded && !error" class="notice" role="status">
      暂时无法刷新，显示的是上次获取的接入状态，已标记为可能过期。
    </p>
    <dl class="status-grid identity-status">
      <div>
        <dt>接入状态</dt>
        <dd>
          <span class="status-dot" :class="stateTone" />{{ stateLabel }}
        </dd>
      </div>
      <div>
        <dt>待传事件</dt>
        <dd>{{ pendingCount }}</dd>
      </div>
      <div>
        <dt>上次成功上传</dt>
        <dd>{{ time(status?.lastSuccessAt) }}</dd>
      </div>
      <div>
        <dt>仪器编号</dt>
        <dd>{{ settings?.instrumentId || "未配置" }}</dd>
      </div>
    </dl>
    <p v-if="status?.lastError" class="error-message" role="alert">
      上传错误：{{ status.lastError }}
    </p>
    <p v-if="status?.acquisitionError" class="error-message" role="alert">
      采集错误：{{ status.acquisitionError }}
    </p>
    <p v-if="registration === 'revoked'" class="notice">
      此仪器已被中心停用。重新启用由管理员在中心仪器页操作，启用后会自动恢复上传。
    </p>
    <form v-if="settings" class="form-stack" @submit.prevent="save">
      <fieldset
        :disabled="!canManage || identityLocked || !!busy || loading || !!typesError || !types.length"
        class="identity-fields"
      >
        <div class="form-columns">
          <label
            >仪器类型<select v-model="form.instrumentType">
              <option v-for="item in types" :key="item.id" :value="item.id">
                {{ item.name }}
              </option>
            </select></label
          >
          <label
            >仪器编号<input
              v-model="form.instrumentId"
              required
              maxlength="24"
              placeholder="例如 A01"
              autocomplete="off"
              spellcheck="false"
          /></label>
        </div>
      </fieldset>
      <p v-if="identityLocked" class="field-help">
        已产生采集事件，仪器编号与类型已锁定，避免历史报告归属改变。更换仪器请联系管理员保留原数据后重新配置采集端。
      </p>
      <p v-else class="field-help">
        编号将转为大写：1–24 位大写字母、数字、- 或 _，以字母或数字开头。保存即申请接入，无需复制令牌。
      </p>
      <p v-if="!canManage" class="muted">
        仪器配置仅允许本机管理员操作，请使用采集电脑的桌面应用。
      </p>
      <div v-if="canManage" class="button-row">
        <button class="primary" :disabled="identityLocked || !!busy || loading || !!typesError || !types.length">
          {{ busy === "save" ? "正在保存…" : "保存并申请接入" }}
        </button>
      </div>
    </form>
    <p v-else-if="loaded" class="muted">未能读取仪器配置。</p>
    <details class="client-diagnostics">
      <summary>上传与补传诊断</summary>
      <p class="field-help">
        关闭窗口不等于停止后台服务；服务持续运行时才会继续采集与上传。停止服务或关机期间无法采集，重启后会核对磁盘上的报告并继续补传。
      </p>
      <dl class="status-grid">
        <div>
          <dt>下次尝试</dt>
          <dd>{{ time(status?.nextAttemptAt) }}</dd>
        </div>
        <div>
          <dt>最早待传</dt>
          <dd>{{ time(status?.oldestPendingAt) }}</dd>
        </div>
        <div>
          <dt>待补扫历史日期</dt>
          <dd>
            {{ status?.queueMetricsStale ? "未知" : (status?.backfillPendingDays ?? "未知") }}
          </dd>
        </div>
        <div>
          <dt>客户端版本</dt>
          <dd>{{ status?.clientVersion || "未知" }}</dd>
        </div>
      </dl>
      <button v-if="canManage && settings?.configured" :disabled="!!busy || loading" @click="retry">
        {{ busy === "retry" ? "正在重试…" : "修复后重试" }}
      </button>
      <form v-if="canManage" class="form-stack" @submit.prevent="backfill">
        <h3>补传历史报告</h3>
        <p class="field-help">
          选择报告目录的日期范围；任务持久保存、分批处理。已上传且未修改的报告不会重复入库。
        </p>
        <div class="form-columns">
          <label
            >起始日期<input
              v-model="history.from"
              type="date"
              required
              :max="history.to || undefined"
          /></label>
          <label
            >结束日期<input
              v-model="history.to"
              type="date"
              required
              :min="history.from || undefined"
          /></label>
        </div>
        <div>
          <button :disabled="historyBusy || loading">
            {{ historyBusy ? "正在安排…" : "安排历史补传" }}
          </button>
        </div>
      </form>
      <p v-if="historyNotice" class="notice" role="status">{{ historyNotice }}</p>
    </details>
  </section>
</template>

<style scoped>
.identity-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.identity-status .status-dot.good {
  background: #4c9b7b;
}
.identity-status .status-dot.warn {
  background: #d99a3d;
}
.identity-status .status-dot.bad {
  background: #c05a4d;
}
.client-diagnostics {
  margin-top: 18px;
}
.client-diagnostics > summary {
  cursor: pointer;
  font-weight: 600;
  color: #455e71;
  padding: 8px 0;
}
</style>
