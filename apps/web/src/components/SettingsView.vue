<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import {
  FolderOpen,
  RefreshCw,
  ChevronRight,
  ArrowUp,
  ExternalLink,
  Copy,
  Power,
  Globe,
  Server,
  Radio,
  ShieldCheck,
} from "lucide-vue-next";
import QRCode from "qrcode";
import { request } from "../api.js";
import Modal from "./Modal.vue";
const props = defineProps({
  user: Object,
  status: Object,
  statusError: String,
  authenticationEnabled: Boolean,
  initialized: Boolean,
});
const emit = defineEmits([
  "refresh-status",
  "reports-changed",
  "access-changed",
]);
const admin = computed(() => props.user.role === "admin");
const settings = ref(null);
const loading = ref(false);
const loadError = ref("");
const error = ref("");
const success = ref("");
const busy = ref("");
const accessOpen = ref(false);
const dataPath = ref("");
const remote = reactive({
  enabled: false,
  url: "",
  serverAddr: "",
  serverPort: 7000,
  remotePort: 18080,
  token: "",
});
const directoryOpen = ref(false);
const directory = ref(null);
const directoryPath = ref("");
const directoryBusy = ref(false);
const directoryError = ref("");
const qr = ref("");
const qrError = ref("");
let directoryController,
  directorySequence = 0,
  qrSequence = 0;
const remoteUrl = computed(() => {
  try {
    const url = new URL(props.status?.remote?.url || "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
});
watch(
  remoteUrl,
  async (url) => {
    const sequence = ++qrSequence;
    qr.value = "";
    qrError.value = "";
    if (!url) return;
    try {
      const image = await QRCode.toDataURL(url, {
        width: 208,
        margin: 2,
        color: { dark: "#1c3545", light: "#ffffff" },
      });
      if (sequence === qrSequence) qr.value = image;
    } catch {
      if (sequence === qrSequence)
        qrError.value = "二维码生成失败，您仍可复制访问地址。";
    }
  },
  { immediate: true },
);
function applySettings(value) {
  settings.value = value;
  dataPath.value = value.dataPath;
  Object.assign(remote, {
    enabled: value.remote.enabled,
    url: value.remote.url,
    serverAddr: value.remote.serverAddr,
    serverPort: value.remote.serverPort,
    remotePort: value.remote.remotePort,
    token: "",
  });
}
async function loadSettings() {
  if (!admin.value) return;
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
async function changeAccess() {
  if (busy.value) return;
  busy.value = "access";
  error.value = "";
  success.value = "";
  try {
    await request("/access", {
      method: "PUT",
      body: { authenticationEnabled: !props.authenticationEnabled },
    });
    accessOpen.value = false;
    emit("access-changed");
  } catch (cause) {
    error.value = cause.message;
    accessOpen.value = false;
  } finally {
    busy.value = "";
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
      }),
    );
    success.value = "报告目录已保存。";
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
    await request("/scan", { method: "POST", body: {} });
    success.value = "重新扫描请求已完成，请查看下方扫描状态。";
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
async function saveRemote(enabled) {
  busy.value = "remote";
  error.value = "";
  success.value = "";
  const source = enabled ? remote : settings.value.remote;
  const body = {
    enabled,
    url: source.url.trim(),
    serverAddr: source.serverAddr.trim(),
    serverPort: Number(source.serverPort),
    remotePort: Number(source.remotePort),
  };
  if (enabled && remote.token) body.token = remote.token;
  try {
    await request("/remote", { method: "PUT", body });
    remote.token = "";
    await loadSettings();
    success.value = enabled
      ? "远程配置已保存，实际连接情况见服务状态。"
      : "远程访问已停止。";
    emit("refresh-status");
  } catch (cause) {
    error.value = cause.message;
    emit("refresh-status");
  } finally {
    busy.value = "";
  }
}
async function copyUrl() {
  error.value = "";
  success.value = "";
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("浏览器不支持自动复制，请长按访问地址复制。");
    await navigator.clipboard.writeText(remoteUrl.value);
    success.value = "访问地址已复制。";
  } catch (cause) {
    error.value = cause.message;
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
  qrSequence++;
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
              ? "管理报告来源与远程访问。"
              : "查看数据服务与远程连接的实际状态。"
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
    <section v-if="admin" class="settings-section">
      <div class="section-heading">
        <ShieldCheck :size="21" />
        <div>
          <h2>访问鉴权</h2>
          <p>
            {{
              authenticationEnabled ? "已开启 · 需要登录" : "已关闭 · 完全公开"
            }}
          </p>
        </div>
      </div>
      <p class="muted">
        {{
          authenticationEnabled
            ? "使用账户登录后访问，账户与权限在账户页管理。"
            : "打开链接即可使用全部功能，包括查看报告和修改设置。"
        }}
      </p>
      <button :disabled="!!busy" @click="accessOpen = true">
        {{ authenticationEnabled ? "关闭鉴权" : "启用鉴权" }}
      </button>
    </section>
    <section class="settings-section">
      <div class="section-heading">
        <Server :size="21" />
        <div>
          <h2>服务状态</h2>
          <p>由服务实时返回，每 15 秒更新。</p>
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
          <div>
            <dt>目录监控</dt>
            <dd>
              <span class="status-dot" :class="{ good: status.watching }" />{{
                status.watching ? "监控中" : "未监控"
              }}
            </dd>
          </div>
          <div>
            <dt>报告缓存</dt>
            <dd>{{ status.reportCount }} 份</dd>
          </div>
          <div>
            <dt>扫描状态</dt>
            <dd>{{ status.scanning ? "正在扫描" : "空闲" }}</dd>
          </div>
          <div>
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
        <details v-if="status.errors?.length" class="scan-errors">
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
    <template v-if="admin"
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
              <p>服务只读取原始报告，不会修改或删除文件。</p>
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
        <section class="settings-section">
          <div class="section-heading">
            <Globe :size="21" />
            <div>
              <h2>远程访问</h2>
              <p>通过 HTTPS 地址，从手机访问同一套报告。</p>
            </div>
          </div>
          <form class="form-stack" @submit.prevent="saveRemote(true)">
            <div class="form-columns">
              <label class="full-width"
                >公网 HTTPS 地址<input
                  v-model="remote.url"
                  type="url"
                  pattern="https://.*"
                  required
                  placeholder="https://reports.example.com" /></label
              ><label
                >FRP 服务器地址<input
                  v-model="remote.serverAddr"
                  required
                  placeholder="frp.example.com" /></label
              ><label
                >服务器端口<input
                  v-model="remote.serverPort"
                  type="number"
                  min="1"
                  max="65535"
                  required /></label
              ><label
                >远程映射端口<input
                  v-model="remote.remotePort"
                  type="number"
                  min="1"
                  max="65535"
                  required /></label
              ><label
                >连接令牌<input
                  v-model="remote.token"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="
                    settings.remote.tokenConfigured
                      ? '已配置，留空保留'
                      : '输入 FRP 连接令牌'
                  "
                  :required="!settings.remote.tokenConfigured"
              /></label>
            </div>
            <p class="field-help">
              需先在服务器配置 FRP 与 HTTPS
              反向代理。令牌只保存在服务本机，不会返回到页面。
            </p>
            <div class="button-row">
              <button class="primary" :disabled="!!busy">
                {{
                  busy === "remote"
                    ? "正在应用…"
                    : remote.enabled
                      ? "保存远程配置"
                      : "保存并启用"
                }}</button
              ><button
                type="button"
                :disabled="!!busy || !settings.remote.enabled"
                @click="saveRemote(false)"
              >
                <Power :size="17" />停止远程访问
              </button>
            </div>
          </form>
        </section></template
      ></template
    >
    <section class="settings-section">
      <div class="section-heading">
        <Radio :size="21" />
        <div>
          <h2>连接与分享</h2>
          <p>
            {{
              status?.remote?.enabled
                ? "启用不代表连接成功，请以实际状态为准。"
                : "远程访问尚未启用。"
            }}
          </p>
        </div>
      </div>
      <p class="remote-state">
        <span
          class="status-dot"
          :class="{ good: status?.remote?.connected }"
        />{{
          !status
            ? "状态未知"
            : status.remote?.connected
              ? "远程已连接"
              : status.remote?.enabled
                ? "尚未连接"
                : "已关闭"
        }}
      </p>
      <p v-if="status?.remote?.lastError" class="error-message">
        {{ status.remote.lastError }}
      </p>
      <div v-if="remoteUrl" class="remote-share">
        <img
          v-if="qr"
          :src="qr"
          alt="手机访问地址二维码"
          width="208"
          height="208"
        />
        <div>
          <p class="muted">
            {{
              authenticationEnabled
                ? "手机扫码打开，然后使用您的账户登录。"
                : "手机扫码或打开链接即可使用，无需登录。"
            }}
          </p>
          <a
            class="remote-link"
            :href="remoteUrl"
            target="_blank"
            rel="noopener noreferrer"
            >{{ remoteUrl }}<ExternalLink :size="16"
          /></a>
          <p v-if="qrError" class="error-message">{{ qrError }}</p>
          <button @click="copyUrl"><Copy :size="17" />复制地址</button>
          <p v-if="!status?.remote?.connected" class="field-help">
            当前未确认连通，该地址可能暂时无法访问。
          </p>
        </div>
      </div>
    </section>
    <Modal
      v-if="accessOpen"
      :title="authenticationEnabled ? '关闭访问鉴权？' : '启用访问鉴权？'"
      @close="accessOpen = false"
    >
      <p v-if="authenticationEnabled" class="muted">
        关闭后，任何能访问此地址的人都可查看报告、浏览目录和修改配置。
        公网地址也会完全开放。已有账户会保留，所有客户端立即切换为公开访问。
      </p>
      <template v-else>
        <p class="muted">启用后，所有客户端都需要登录才能继续使用。</p>
        <p class="muted">
          {{
            initialized
              ? "已有账户会继续保留，请确保记得管理员账户与密码。"
              : "尚无账户，接下来需要使用服务本机的设置令牌创建管理员。本机桌面会自动读取令牌。"
          }}
        </p>
      </template>
      <template #footer>
        <button :disabled="!!busy" @click="accessOpen = false">取消</button>
        <button class="primary" :disabled="!!busy" @click="changeAccess">
          {{ busy === "access" ? "正在切换…" : "确认切换" }}
        </button>
      </template>
    </Modal>
    <Modal
      v-if="directoryOpen"
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
