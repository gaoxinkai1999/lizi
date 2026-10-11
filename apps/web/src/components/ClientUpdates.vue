<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Download,
  RefreshCw,
  Rocket,
  ShieldCheck,
  ExternalLink,
} from "lucide-vue-next";
import Modal from "./Modal.vue";
import { CENTER_URL } from "../../../../packages/core/src/deployment.js";

const bridge = window.liziDesktop;
const canUpdate = computed(
  () =>
    typeof bridge?.getUpdateStatus === "function" &&
    typeof bridge?.checkUpdate === "function" &&
    typeof bridge?.downloadUpdate === "function" &&
    typeof bridge?.installUpdate === "function",
);

const status = ref(null);
const busy = ref("");
const error = ref("");
const notice = ref("");
const confirmInstall = ref(false);
let unsubscribe, disposed = false;

const stateLabels = {
  idle: "待检查",
  checking: "正在检查",
  "up-to-date": "已是最新",
  available: "有新版本",
  downloading: "正在下载",
  ready: "已就绪，可安装",
  installing: "正在安装",
  error: "出错",
};
const stateLabel = computed(
  () => stateLabels[status.value?.state] || "未知",
);
const latest = computed(() => status.value?.latest || null);
const progress = computed(() => status.value?.progress || null);
const newerAvailable = computed(
  () =>
    Boolean(latest.value) &&
    ["available", "downloading", "ready", "error"].includes(status.value?.state),
);

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
function time(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无";
}
function apply(next) {
  if (next && typeof next === "object") status.value = next;
}

async function refresh() {
  if (!canUpdate.value || disposed) return;
  try {
    apply(await bridge.getUpdateStatus());
  } catch (cause) {
    error.value = `无法读取更新状态：${cause.message || cause}`;
  }
}
async function check() {
  busy.value = "check";
  error.value = "";
  notice.value = "";
  try {
    apply(await bridge.checkUpdate());
  } catch (cause) {
    error.value = `检查更新失败：${cause.message || cause}`;
  } finally {
    busy.value = "";
  }
}
async function download() {
  if (!latest.value) return;
  busy.value = "download";
  error.value = "";
  notice.value = "";
  try {
    const result = await bridge.downloadUpdate();
    apply(result);
    if (result?.state === "ready" && result.ready)
      notice.value = "安装包已下载并校验完成，可点击“安装并重启”继续升级。";
  } catch (cause) {
    error.value = `下载失败：${cause.message || cause}`;
  } finally {
    busy.value = "";
  }
}
async function install() {
  busy.value = "install";
  error.value = "";
  notice.value = "";
  try {
    const result = await bridge.installUpdate();
    confirmInstall.value = false;
    if (result?.ok)
      notice.value =
        "已启动官方安装程序，将请求系统授权；安装期间本窗口会退出，完成后由新版本接管。";
    else if (result?.cancelled) notice.value = "已取消安装。";
    else error.value = `安装未完成：${result?.error || "未知原因"}`;
  } catch (cause) {
    error.value = `安装失败：${cause.message || cause}`;
  } finally {
    busy.value = "";
    refresh();
  }
}

onMounted(() => {
  if (!canUpdate.value) return;
  refresh();
  if (typeof bridge.onUpdateStatus === "function")
    unsubscribe = bridge.onUpdateStatus((next) => apply(next));
});
onUnmounted(() => {
  disposed = true;
  unsubscribe?.();
});
</script>

<template>
  <section class="settings-section">
    <div class="section-heading">
      <Rocket :size="21" />
      <div>
        <h2>版本更新</h2>
        <p>
          {{
            canUpdate
              ? "由你手动检查、下载并安装桌面版本。"
              : "此环境未提供桌面更新能力，请在采集电脑的桌面应用里检查更新。"
          }}
        </p>
      </div>
      <button
        v-if="canUpdate"
        class="icon-button"
        aria-label="刷新更新状态"
        :disabled="!!busy"
        @click="refresh"
      >
        <RefreshCw :size="18" :class="{ spinning: !!busy }" />
      </button>
    </div>

    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-if="notice" class="success-message" role="status">{{ notice }}</p>

    <template v-if="canUpdate">
      <dl class="status-grid">
        <div>
          <dt>当前版本</dt>
          <dd>{{ status?.currentVersion || "未知" }}</dd>
        </div>
        <div>
          <dt>最新版本</dt>
          <dd>{{ latest?.version || (status?.state === "up-to-date" ? "无更新版本" : "尚未检查") }}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            <span
              class="status-dot"
              :class="{ good: status?.state === 'up-to-date' || status?.ready }"
            />{{ stateLabel }}
          </dd>
        </div>
        <div>
          <dt>最近检查</dt>
          <dd>{{ time(status?.lastCheckedAt) }}</dd>
        </div>
      </dl>
      <div v-if="latest" class="update-latest">
        <p>
          <strong>{{ latest.version }}</strong>
          <span class="muted"> · {{ formatBytes(latest.size) }} · 发布 {{ time(latest.publishedAt) }}</span>
        </p>
        <p v-if="latest.notes" class="update-notes">{{ latest.notes }}</p>
      </div>
      <div
        v-if="progress && status?.state === 'downloading'"
        class="update-progress"
        role="progressbar"
        :aria-valuenow="progress.percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="update-progress-bar" :style="{ width: (progress.percent || 0) + '%' }" />
        <span
          >{{ formatBytes(progress.received) }} /
          {{ formatBytes(progress.total) }}（{{ progress.percent || 0 }}%）</span
        >
      </div>
      <p v-if="status?.error" class="error-message" role="alert">
        更新错误：{{ status.error }}
      </p>
      <div class="button-row">
        <button :disabled="!!busy" @click="check">
          <RefreshCw :size="17" :class="{ spinning: busy === 'check' }" />{{
            busy === "check" ? "正在检查…" : "检查更新"
          }}
        </button>
        <button
          v-if="newerAvailable && status?.state !== 'ready'"
          :disabled="!!busy"
          @click="download"
        >
          <Download :size="17" />{{
            status?.state === "downloading" ? "正在下载…" : "下载更新"
          }}
        </button>
        <button
          v-if="status?.ready"
          class="primary"
          :disabled="!!busy"
          @click="confirmInstall = true"
        >
          <ShieldCheck :size="17" />安装并重启
        </button>
      </div>
      <p class="field-help">
        更新仅在中心发布且你明确点击后下载安装，安装使用官方安装包并需要系统授权；不会静默升级。完成安装前该页面不会承诺已安装新版本。
      </p>
    </template>

    <template v-else>
      <p class="notice" role="status">
        此环境未提供桌面更新能力，不能在这里安装更新。请在采集电脑的桌面应用中检查并安装，或访问中心站点查看说明。
      </p>
      <a class="text-link" :href="CENTER_URL" target="_blank" rel="noopener noreferrer">
        <ExternalLink :size="16" />打开中心站点
      </a>
    </template>

    <Modal
      v-if="confirmInstall"
      title="安装并重启？"
      @close="!busy && (confirmInstall = false)"
    >
      <p>
        将启动官方安装程序并请求系统授权；安装期间应用会退出，后台服务保留到安装程序完成升级。请先保存工作。
      </p>
      <template #footer>
        <button :disabled="!!busy" @click="confirmInstall = false">取消</button>
        <button class="primary" :disabled="!!busy" @click="install">
          {{ busy === "install" ? "正在启动…" : "确认安装" }}
        </button>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.update-latest {
  margin: 4px 0 12px;
}
.update-notes {
  white-space: pre-wrap;
  color: #55697a;
  font-size: 13px;
  margin: 6px 0 0;
}
.update-progress {
  position: relative;
  height: 26px;
  border-radius: 7px;
  background: #eef2f5;
  overflow: hidden;
  margin: 10px 0;
}
.update-progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: #cfe3dd;
  transition: width 0.2s ease;
}
.update-progress span {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #3c607d;
}
.text-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #3c607d;
}
</style>
