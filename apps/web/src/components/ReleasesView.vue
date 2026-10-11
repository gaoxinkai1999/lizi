<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Package,
  UploadCloud,
  Download,
  Undo2,
  RefreshCw,
  FileCheck2,
} from "lucide-vue-next";
import { request, upload } from "../api.js";
import Modal from "./Modal.vue";

const props = defineProps({ user: Object });
const emit = defineEmits(["refresh-status"]);
const admin = computed(() => props.user?.role === "admin");

const releases = ref([]);
const latest = ref(null);
const loading = ref(false);
const loaded = ref(false);
const stale = ref(false);
const error = ref("");
const success = ref("");
const loadError = ref("");
const installer = ref(null);
const sidecar = ref(null);
const sidecarError = ref("");
const uploadState = ref({ busy: false, stage: "", percent: 0 });
const withdrawTarget = ref(null);
const withdrawBusy = ref(false);
let timer, disposed = false;

const staged = computed(() => {
  const manifest = sidecar.value?.manifest;
  if (!manifest) return null;
  return {
    version: manifest.version || "",
    filename: manifest.filename || "",
    size: manifest.size,
    sha256: manifest.sha256 || "",
    notes: manifest.notes || "",
  };
});
const mismatch = computed(() => {
  if (!installer.value || !staged.value) return "";
  if (staged.value.filename && staged.value.filename !== installer.value.name)
    return `侧车文件声明的文件名 ${staged.value.filename} 与所选安装包 ${installer.value.name} 不一致，服务器会拒绝。`;
  if (
    Number.isFinite(Number(staged.value.size)) &&
    Number(staged.value.size) !== installer.value.size
  )
    return `侧车声明的文件大小与所选安装包不一致（声明 ${staged.value.size}，实际 ${installer.value.size}），服务器会拒绝。`;
  return "";
});
const canUpload = computed(
  () => Boolean(installer.value && sidecar.value && staged.value?.version) && !uploadState.value.busy,
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
function shortHash(value) {
  return value ? `${String(value).slice(0, 12)}…` : "—";
}
function downloadHref(entry) {
  return entry.url || `/api/releases/${encodeURIComponent(entry.version)}/download`;
}

async function load() {
  if (loading.value || !admin.value || disposed) return;
  loading.value = true;
  try {
    const data = await request("/releases", { retries: 0 });
    if (disposed) return;
    releases.value = data.releases || [];
    latest.value = data.latest || null;
    loaded.value = true;
    stale.value = false;
    loadError.value = "";
  } catch (cause) {
    if (disposed) return;
    loadError.value = cause.message;
    stale.value = true;
  } finally {
    loading.value = false;
  }
}

function onInstaller(event) {
  installer.value = event.target.files?.[0] || null;
  success.value = "";
  error.value = "";
}
async function onSidecar(event) {
  sidecar.value = null;
  sidecarError.value = "";
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed?.manifest?.version || !parsed?.signature)
      throw new Error("缺少 manifest 或 signature 字段。");
    sidecar.value = parsed;
  } catch (cause) {
    sidecarError.value = `侧车文件无效：${cause.message}`;
  }
}

async function publish() {
  if (!canUpload.value) return;
  const manifest = sidecar.value.manifest;
  const version = manifest.version;
  uploadState.value = { busy: true, stage: "artifact", percent: 0 };
  error.value = "";
  success.value = "";
  try {
    await upload(
      `/releases/${encodeURIComponent(version)}/artifact`,
      installer.value,
      {
        method: "PUT",
        contentType: "application/octet-stream",
        onProgress: (loaded, total) => {
          uploadState.value = {
            busy: true,
            stage: "artifact",
            percent: total ? Math.round((loaded / total) * 100) : 0,
          };
        },
      },
    );
    uploadState.value = { busy: true, stage: "publish", percent: 100 };
    await request("/releases", {
      method: "POST",
      body: { manifest, signature: sidecar.value.signature },
    });
    success.value = `已发布 ${version}（${formatBytes(manifest.size)}）。客户端可手动检查并下载安装。`;
    installer.value = null;
    sidecar.value = null;
    uploadState.value = { busy: false, stage: "", percent: 0 };
    await load();
    emit("refresh-status");
  } catch (cause) {
    error.value = cause.message;
    uploadState.value = { busy: false, stage: "", percent: 0 };
  }
}

async function withdraw() {
  if (withdrawBusy.value || !withdrawTarget.value) return;
  withdrawBusy.value = true;
  error.value = "";
  success.value = "";
  try {
    await request(`/releases/${encodeURIComponent(withdrawTarget.value.version)}`, {
      method: "DELETE",
      body: {},
    });
    success.value = `已撤回 ${withdrawTarget.value.version}，文件保留但不再对外提供；已下载的旧版本不受影响。`;
    withdrawTarget.value = null;
    await load();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    withdrawBusy.value = false;
    withdrawTarget.value = null;
  }
}

onMounted(() => {
  load();
  timer = setInterval(() => {
    if (!uploadState.value.busy && document.visibilityState === "visible") load();
  }, 30_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>

<template>
  <section class="releases-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">RELEASES</p>
        <h1>版本</h1>
        <p class="muted">
          发布桌面安装包与签名清单；客户端手动检查下载，中心不推送安装命令。
        </p>
      </div>
      <button
        class="icon-button"
        aria-label="刷新版本列表"
        :disabled="loading || uploadState.busy"
        @click="load"
      >
        <RefreshCw :size="20" :class="{ spinning: loading }" />
      </button>
    </div>

    <p v-if="!admin" class="notice" role="status">
      仅管理员可发布或撤出版本。
    </p>
    <template v-else>
      <p v-if="error || loadError" class="error-message" role="alert">
        {{ error || loadError }}{{ loadError && stale && loaded ? "（下方为上次获取的数据，可能已过期）" : "" }}
      </p>
      <p v-if="success" class="success-message" role="status">{{ success }}</p>
      <p v-if="stale && loaded && !error" class="notice" role="status">
        刷新失败，显示上次获取的版本列表并标记为可能过期。
      </p>

      <section class="settings-section">
        <div class="section-heading">
          <UploadCloud :size="21" />
          <div>
            <h2>发布新版本</h2>
            <p>先上传安装包二进制（带进度），再用签名侧车发布元数据。</p>
          </div>
        </div>
        <div class="release-upload form-columns">
          <label
            >安装包（.exe）
            <input
              type="file"
              accept=".exe,application/octet-stream"
              :disabled="uploadState.busy"
              @change="onInstaller"
            />
            <span class="field-help">{{
              installer ? `${installer.name} · ${formatBytes(installer.size)}` : "选择 Lizi-Setup-x.y.z-x64.exe"
            }}</span>
          </label>
          <label
            >签名侧车（.release.json）
            <input
              type="file"
              accept=".json,application/json"
              :disabled="uploadState.busy"
              @change="onSidecar"
            />
            <span class="field-help">{{
              sidecar ? `manifest ${staged.version}` : "由 sign-release.js 生成的 .release.json"
            }}</span>
          </label>
        </div>
        <p v-if="sidecarError" class="error-message" role="alert">
          {{ sidecarError }}
        </p>
        <div v-if="staged" class="release-preview">
          <p>
            <FileCheck2 :size="16" />将发布
            <strong>{{ staged.version }}</strong> · {{ staged.filename || "未命名" }} ·
            {{ formatBytes(staged.size) }}
          </p>
          <p class="muted">sha256 {{ shortHash(staged.sha256) }}</p>
          <p v-if="staged.notes" class="update-notes">{{ staged.notes }}</p>
        </div>
        <p v-if="mismatch" class="error-message" role="alert">{{ mismatch }}</p>
        <div v-if="uploadState.busy" class="release-progress" role="progressbar"
          :aria-valuenow="uploadState.percent" aria-valuemin="0" aria-valuemax="100">
          <div class="release-progress-bar" :style="{ width: uploadState.percent + '%' }" />
          <span>
            {{ uploadState.stage === "artifact" ? "正在上传安装包" : "正在发布元数据" }}
            {{ uploadState.stage === "artifact" ? uploadState.percent + "%" : "" }}
          </span>
        </div>
        <div class="button-row">
          <button class="primary" :disabled="!canUpload || !!mismatch" @click="publish">
            <UploadCloud :size="17" />{{ uploadState.busy ? "正在发布…" : "上传并发布" }}
          </button>
        </div>
        <p class="field-help">
          发布后版本不可修改；需要下线时使用撤回，已发布过的旧版本仍可作为回退保留。
        </p>
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <Package :size="21" />
          <div>
            <h2>版本列表</h2>
            <p v-if="latest">最新：{{ latest.version }}（{{ time(latest.publishedAt) }}）</p>
            <p v-else>尚未发布任何版本。</p>
          </div>
        </div>
        <p v-if="!loaded && loading" class="muted">正在读取版本…</p>
        <p v-else-if="!releases.length" class="muted">
          还没有发布记录。上传安装包与签名侧车后即可发布。
        </p>
        <div v-else class="table-wrap">
          <table class="release-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>状态</th>
                <th>大小</th>
                <th>sha256</th>
                <th>发布时间</th>
                <th>说明</th>
                <th class="actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in releases"
                :key="entry.version"
                :class="{ withdrawn: entry.status === 'withdrawn', latest: latest && entry.version === latest.version }"
              >
                <td>
                  <strong>{{ entry.version }}</strong>
                  <span v-if="latest && entry.version === latest.version" class="badge">最新</span>
                </td>
                <td>
                  <span class="dev-state" :class="entry.status === 'published' ? 'online' : 'revoked'">{{
                    entry.status === "published" ? "已发布" : "已撤回"
                  }}</span>
                </td>
                <td>{{ formatBytes(entry.size) }}</td>
                <td class="mono">{{ shortHash(entry.sha256) }}</td>
                <td>{{ time(entry.publishedAt) }}</td>
                <td class="notes-cell">{{ entry.notes || "—" }}</td>
                <td class="actions-col">
                  <a
                    v-if="entry.status === 'published'"
                    class="small button-link"
                    :href="downloadHref(entry)"
                    download
                  ><Download :size="15" />下载</a>
                  <button
                    v-if="entry.status === 'published'"
                    class="small"
                    @click="withdrawTarget = entry"
                  >
                    <Undo2 :size="15" />撤回
                  </button>
                  <span v-else class="muted">已下线</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <Modal
      v-if="withdrawTarget"
      title="撤回此版本？"
      @close="!withdrawBusy && (withdrawTarget = null)"
    >
      <p>
        {{ withdrawTarget.version }}：撤回后不再对外提供下载，但文件保留以便必要时回退；已下载的客户端不受影响。
      </p>
      <template #footer>
        <button :disabled="withdrawBusy" @click="withdrawTarget = null">取消</button>
        <button class="primary" :disabled="withdrawBusy" @click="withdraw">
          {{ withdrawBusy ? "正在撤回…" : "确认撤回" }}
        </button>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.release-upload {
  margin: 6px 0 12px;
}
.release-preview {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px 14px;
  margin: 8px 0;
  background: #f8fafb;
}
.release-preview p {
  margin: 2px 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.update-notes {
  white-space: pre-wrap;
  color: #55697a;
}
.release-progress {
  position: relative;
  height: 26px;
  border-radius: 7px;
  background: #eef2f5;
  overflow: hidden;
  margin: 10px 0;
}
.release-progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: #cfe3dd;
  transition: width 0.2s ease;
}
.release-progress span {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #3c607d;
}
.release-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.release-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #8a97a5;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.release-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #eef1f4;
  vertical-align: middle;
}
.release-table tr.withdrawn td {
  color: #97a2ad;
}
.release-table tr.latest td {
  background: #f6fbf8;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.notes-cell {
  max-width: 260px;
  white-space: normal;
}
.actions-col {
  text-align: right;
  white-space: nowrap;
}
.actions-col .small {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 6px;
}
button.small,
.button-link.small {
  padding: 5px 10px;
  font-size: 12px;
  min-height: 30px;
}
.button-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: white;
  color: #455e71;
  text-decoration: none;
}
@media (max-width: 760px) {
  .release-table th:nth-child(4),
  .release-table td:nth-child(4),
  .release-table th:nth-child(6),
  .release-table td:nth-child(6) {
    display: none;
  }
}
</style>
