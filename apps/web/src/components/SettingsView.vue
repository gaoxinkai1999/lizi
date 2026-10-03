<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  FolderOpen,
  RefreshCw,
  ChevronRight,
  ArrowUp,
  Server,
  ShieldCheck,
} from "lucide-vue-next";
import { request } from "../api.js";
import Modal from "./Modal.vue";
import LanSettings from "./LanSettings.vue";
import CloudSettings from "./CloudSettings.vue";
const props = defineProps({
  user: Object,
  status: Object,
  statusError: String,
  deploymentMode: String,
});
const emit = defineEmits([
  "refresh-status",
  "reports-changed",
]);
const admin = computed(() => props.user?.role === "admin");
const server = computed(() => props.deploymentMode === "server");
const settings = ref(null);
const loading = ref(false);
const loadError = ref("");
const error = ref("");
const success = ref("");
const busy = ref("");
const dataPath = ref("");
const directoryOpen = ref(false);
const directory = ref(null);
const directoryPath = ref("");
const directoryBusy = ref(false);
const directoryError = ref("");
let directoryController, directorySequence = 0;
function applySettings(value) {
  settings.value = value;
  dataPath.value = value.dataPath || "";
}
async function loadSettings() {
  if (!admin.value || server.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    applySettings(await request("/settings"));
  } catch (cause) {
    loadError.value = cause.message;
  } finally {
    loading.value = false;
  }
}
async function saveDirectory() {
  busy.value = "path";
  error.value = "";
  success.value = "";
  try {
    applySettings(
      await request("/settings", {
        method: "PUT",
        body: { dataPath: dataPath.value.trim() },
        localAdmin: true,
      }),
    );
    success.value = "报告根目录已保存，所选日期的数据将在后台按需准备。";
    emit("refresh-status");
    emit("reports-changed");
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function scan() {
  busy.value = "scan";
  error.value = "";
  success.value = "";
  try {
    await request("/scan", { method: "POST", body: {}, localAdmin: true });
    success.value =
      "已启动当前活跃日期的后台扫描，请查看下方进度；这不表示扫描已完成。";
    emit("refresh-status");
    emit("reports-changed");
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function browse(path = "") {
  directoryOpen.value = true;
  directoryBusy.value = true;
  directoryError.value = "";
  directoryController?.abort();
  directoryController = new AbortController();
  const sequence = ++directorySequence;
  try {
    const result = await request(
      `/directories?${new URLSearchParams({ path })}`,
      { signal: directoryController.signal },
    );
    if (sequence === directorySequence) {
      directory.value = result;
      directoryPath.value = result.path;
    }
  } catch (cause) {
    if (sequence === directorySequence && cause.name !== "AbortError")
      directoryError.value = cause.message;
  } finally {
    if (sequence === directorySequence) directoryBusy.value = false;
  }
}
function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未扫描";
}
function uptime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
}
onMounted(loadSettings);
onUnmounted(() => {
  directorySequence++;
  directoryController?.abort();
});
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <p class="eyebrow">{{ admin ? "SETTINGS" : "SERVICE" }}</p>
        <h1>{{ admin ? "系统设置" : "服务状态" }}</h1>
        <p class="muted">
          {{
            admin
              ? "管理报告来源与中心服务器同步。"
              : "查看数据服务与上传连接的实际状态。"
          }}
        </p>
      </div>
      <button
        aria-label="刷新服务状态"
        class="icon-button"
        @click="emit('refresh-status')"
      >
        <RefreshCw :size="20" />
      </button>
    </div>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <p v-if="success" class="success-message" role="status">{{ success }}</p>
    <section v-if="admin && server" class="settings-section">
      <div class="section-heading">
        <ShieldCheck :size="21" />
        <div>
          <h2>访问鉴权</h2>
          <p>已开启 · 需要登录</p>
        </div>
      </div>
      <p class="muted">
        中心服务器必须登录，账户与权限在账户页管理。
      </p>
    </section>
    <section class="settings-section">
      <div class="section-heading">
        <Server :size="21" />
        <div>
          <h2>服务状态</h2>
          <p>{{ server ? "显示中心服务器已收到的数据；客户端离线或积压时，报告可能不完整。" : "本地查询按所选日期准备数据；开启上传后会在后台独立采集与补传。" }}</p>
        </div>
      </div>
      <p v-if="statusError" class="error-message" role="alert">
        状态更新失败：{{ statusError }}。下方可能是上次获取的数据。
      </p>
      <p v-if="!status" class="muted">
        {{ statusError ? "暂时无法获取状态。" : "正在读取服务状态…" }}
      </p>
      <template v-else
        ><dl class="status-grid">
          <div v-if="!server">
            <dt>目录监控</dt>
            <dd>
              <span class="status-dot" :class="{ good: status.watching }" />{{
                status.watching ? "监控中" : "未监控"
              }}
            </dd>
          </div>
          <div>
            <dt>{{ server ? "已接收报告" : "本地报告" }}</dt>
            <dd>{{ status.reportCount }} 份</dd>
          </div>
          <div v-if="!server">
            <dt>扫描状态</dt>
            <dd>{{ status.scanning ? "正在扫描" : "空闲" }}</dd>
          </div>
          <div v-if="!server && status.scanProgress">
            <dt>当前日期扫描进度</dt>
            <dd>
              已检查 {{ status.scanProgress.visited }} 个 · 已入库
              {{ status.scanProgress.indexed }} 份 · 无效
              {{ status.scanProgress.invalid }} 个
            </dd>
          </div>
          <div v-if="!server">
            <dt>最近扫描</dt>
            <dd>{{ formatTime(status.lastScan) }}</dd>
          </div>
          <div>
            <dt>运行方式</dt>
            <dd>
              {{ status.service?.mode === "service" ? "系统服务" : "独立运行" }}
            </dd>
          </div>
          <div>
            <dt>持续运行</dt>
            <dd>{{ uptime(status.service?.uptime) }}</dd>
          </div>
          <div>
            <dt>服务版本</dt>
            <dd>{{ status.version }}</dd>
          </div>
          <div>
            <dt>数据版本</dt>
            <dd>{{ status.revision }}</dd>
          </div>
        </dl>
        <details v-if="!server && status.errors?.length" class="scan-errors">
          <summary>{{ status.errors.length }} 个扫描问题</summary>
          <ul>
            <li v-for="(item, index) in status.errors" :key="index">
              <strong>{{ item.path }}</strong>
              <p>{{ item.message }}</p>
            </li>
          </ul>
        </details></template
      >
    </section>
    <CloudSettings :deployment-mode="deploymentMode" :user="user" :sync-status="status?.sync" />
    <LanSettings v-if="!server && props.user" />
    <template v-if="admin && !server"
      ><p v-if="loading && !settings" class="notice">正在读取配置…</p>
      <div v-if="loadError" class="error-message" role="alert">
        {{ loadError }} <button @click="loadSettings">重新读取设置</button>
      </div>
      <template v-if="settings"
        ><section class="settings-section">
          <div class="section-heading">
            <FolderOpen :size="21" />
            <div>
              <h2>报告目录</h2>
              <p>
                请选择包含 YYYY-MM-DD
                日期子目录的根目录，不是某一天的目录。查询按日期读取，上传会在后台采集与补传；原始文件不会被修改或删除。
              </p>
            </div>
          </div>
          <form class="form-stack" @submit.prevent="saveDirectory">
            <label
              >数据目录
              <div class="input-action">
                <input
                  v-model="dataPath"
                  required
                  placeholder="选择报告所在的目录"
                /><button
                  type="button"
                  :disabled="!!busy"
                  @click="browse(dataPath)"
                >
                  <FolderOpen :size="18" />浏览
                </button>
              </div></label
            >
            <details class="allowed-roots">
              <summary>允许访问的目录范围</summary>
              <ul>
                <li v-for="root in settings.allowedRoots" :key="root">
                  {{ root }}
                </li>
              </ul>
            </details>
            <div class="button-row">
              <button class="primary" :disabled="!!busy">
                {{ busy === "path" ? "保存中…" : "保存目录" }}</button
              ><button
                type="button"
                :disabled="!!busy || status?.scanning"
                @click="scan"
              >
                <RefreshCw
                  :size="17"
                  :class="{ spinning: busy === 'scan' }"
                />{{
                  busy === "scan" || status?.scanning ? "扫描中…" : "重新扫描"
                }}
              </button>
            </div>
          </form>
        </section>
        </template
      ></template
    >
    <Modal
      v-if="!server && directoryOpen"
      title="选择报告目录"
      @close="directoryOpen = false"
      ><p class="muted">浏览的是服务电脑上的目录，不是当前手机的文件。</p>
      <form class="directory-path" @submit.prevent="browse(directoryPath)">
        <label class="sr-only" for="browse-path">目录路径</label
        ><input
          id="browse-path"
          v-model="directoryPath"
          placeholder="输入允许范围内的目录"
        /><button :disabled="directoryBusy">前往</button>
      </form>
      <p v-if="directoryError" role="alert" class="error-message">
        {{ directoryError }}
      </p>
      <div class="directory-roots">
        <button
          v-for="root in directory?.roots || settings?.allowedRoots || []"
          :key="root"
          class="root-button"
          :disabled="directoryBusy"
          @click="browse(root)"
        >
          <FolderOpen :size="17" />{{ root }}
        </button>
      </div>
      <button
        v-if="directory?.parent"
        :disabled="directoryBusy"
        @click="browse(directory.parent)"
      >
        <ArrowUp :size="17" />上一级
      </button>
      <p v-if="directoryBusy" role="status" class="muted">正在读取目录…</p>
      <div v-else-if="directory" class="directory-list">
        <p class="current-path">{{ directory.path }}</p>
        <button
          v-for="item in directory.directories"
          :key="item.path"
          @click="browse(item.path)"
        >
          <FolderOpen :size="19" /><span>{{ item.name }}</span
          ><ChevronRight :size="17" />
        </button>
        <p v-if="!directory.directories.length" class="muted">
          此目录没有子目录，可以直接选择。
        </p>
      </div>
      <template #footer
        ><button @click="directoryOpen = false">取消</button
        ><button
          class="primary"
          :disabled="directoryBusy || !directory?.path || !!directoryError"
          @click="
            dataPath = directory.path;
            directoryOpen = false;
          "
        >
          使用此目录
        </button></template
      ></Modal
    >
  </section>
</template>
