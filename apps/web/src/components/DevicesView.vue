<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Cpu,
  RefreshCw,
  Check,
  Ban,
  RotateCcw,
  Pencil,
  ChevronDown,
} from "lucide-vue-next";
import { request } from "../api.js";
import Modal from "./Modal.vue";

const props = defineProps({ user: Object });
const emit = defineEmits(["refresh-status"]);
const admin = computed(() => props.user?.role === "admin");

const devices = ref([]);
const summary = ref(null);
const loading = ref(false);
const loaded = ref(false);
const stale = ref(false);
const error = ref("");
const success = ref("");
const filter = ref("all");
const busyId = ref("");
const expanded = ref("");
const editor = ref(null);
const editorForm = ref({ name: "", location: "" });
const editorBusy = ref(false);
const editorError = ref("");
const confirmAction = ref(null);
let timer, events, disposed = false;

const registrationLabels = {
  pending: "待批准",
  approved: "已批准",
  revoked: "已停用",
};
const connectionLabels = {
  pending: "待接入",
  online: "在线",
  unstable: "连接不稳",
  offline: "离线",
  revoked: "停用",
};

function abnormal(device) {
  return (
    device.registrationState === "approved" &&
    (device.connectionState !== "online" ||
      Boolean(device.lastError) ||
      Boolean(device.acquisitionError))
  );
}

const counts = computed(() => {
  const list = devices.value;
  const fallback = {
    pending: list.filter((item) => item.registrationState === "pending").length,
    online: list.filter((item) => item.connectionState === "online").length,
    unstable: list.filter((item) => item.connectionState === "unstable").length,
    offline: list.filter((item) => item.connectionState === "offline").length,
    revoked: list.filter((item) => item.registrationState === "revoked").length,
    errors: list.filter(
      (item) => item.lastError || item.acquisitionError,
    ).length,
  };
  const source = summary.value || {};
  return {
    pending: source.pending ?? fallback.pending,
    online: source.online ?? fallback.online,
    unstable: source.unstable ?? fallback.unstable,
    offline: source.offline ?? fallback.offline,
    revoked: source.revoked ?? fallback.revoked,
    errors: source.errors ?? fallback.errors,
  };
});
const abnormalCount = computed(() => devices.value.filter(abnormal).length);
const filters = computed(() => [
  { id: "all", label: "全部", count: devices.value.length },
  { id: "pending", label: "待批准", count: counts.value.pending },
  { id: "abnormal", label: "异常", count: abnormalCount.value },
  { id: "revoked", label: "已停用", count: counts.value.revoked },
]);
const visible = computed(() => {
  if (filter.value === "pending")
    return devices.value.filter((item) => item.registrationState === "pending");
  if (filter.value === "abnormal")
    return devices.value.filter((item) => abnormal(item));
  if (filter.value === "revoked")
    return devices.value.filter((item) => item.registrationState === "revoked");
  return devices.value;
});

function time(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无";
}
function typeName(id) {
  return id === "strength" ? "强度仪" : id || "未知";
}
function toggle(id) {
  expanded.value = expanded.value === id ? "" : id;
}

async function load() {
  if (loading.value || !admin.value || disposed) return;
  loading.value = true;
  try {
    const data = await request("/devices", { retries: 0 });
    if (disposed) return;
    devices.value = data.devices || [];
    summary.value = data.summary || null;
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

async function runAction(device, action) {
  if (busyId.value) return;
  busyId.value = device.id;
  error.value = "";
  success.value = "";
  try {
    const result = await request(
      `/devices/${encodeURIComponent(device.id)}${
        action === "approve" ? "/approve" : ""
      }`,
      {
        method: action === "approve" ? "POST" : "DELETE",
        body: {},
      },
    );
    const view = result?.device;
    const name = view?.name || device.name;
    if (action === "approve")
      success.value =
        device.registrationState === "revoked"
          ? `已重新启用 ${name}，凭据保持不变，客户端会自动恢复上传。`
          : `已批准 ${name} 接入。`;
    else if (result?.rejected)
      success.value = `已拒绝 ${
        device.instrumentId || name
      } 的接入申请并释放该仪器编号。`;
    else success.value = `已停用 ${name}，其已有报告全部保留。`;
    await load();
    emit("refresh-status");
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busyId.value = "";
    confirmAction.value = null;
  }
}

function openEditor(device) {
  editor.value = device;
  editorForm.value = { name: device.name || "", location: device.location || "" };
  editorError.value = "";
}
async function saveEditor() {
  if (editorBusy.value || !editor.value) return;
  const name = editorForm.value.name.trim();
  if (!name) {
    editorError.value = "名称不能为空。";
    return;
  }
  editorBusy.value = true;
  editorError.value = "";
  try {
    await request(`/devices/${encodeURIComponent(editor.value.id)}`, {
      method: "PATCH",
      body: {
        name,
        location: editorForm.value.location.trim() || null,
      },
    });
    success.value = "已更新显示信息。";
    editor.value = null;
    await load();
  } catch (cause) {
    editorError.value = cause.message;
  } finally {
    editorBusy.value = false;
  }
}

function startSession() {
  events = new EventSource("/api/events", { withCredentials: true });
  events.addEventListener("devices", () => load());
  events.onerror = () => {
    /* The 30-second poll keeps the table fresh if SSE drops. */
  };
}
onMounted(() => {
  load();
  startSession();
  timer = setInterval(() => {
    if (!busyId.value && document.visibilityState === "visible") load();
  }, 30_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  events?.close();
});
</script>

<template>
  <section class="devices-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">INSTRUMENTS</p>
        <h1>仪器</h1>
        <p class="muted">
          各采集电脑独立上传。在线 {{ counts.online }} · 待传异常一眼可见，断线后会自动恢复。
        </p>
      </div>
      <button
        class="icon-button"
        aria-label="刷新仪器列表"
        :disabled="loading"
        @click="load"
      >
        <Cpu :size="20" />
      </button>
    </div>

    <p v-if="!admin" class="notice" role="status">
      仅管理员可管理仪器，报告查看者不能批准或停用。
    </p>
    <template v-else>
      <p v-if="error" class="error-message" role="alert">
        {{ error }}{{ stale && loaded ? "（下方为上次获取的数据，可能已过期）" : "" }}
      </p>
      <p v-if="success" class="success-message" role="status">{{ success }}</p>
      <p v-if="stale && loaded && !error" class="notice" role="status">
        刷新失败，显示上次获取的仪器数据并标记为可能过期；恢复联网后自动更新。
      </p>

      <div class="device-toolbar" role="group" aria-label="仪器筛选">
        <button
          v-for="item in filters"
          :key="item.id"
          type="button"
          class="filter-chip"
          :class="{ active: filter === item.id, alert: item.id === 'pending' && item.count, bad: item.id === 'abnormal' && item.count }"
          :aria-pressed="filter === item.id"
          @click="filter = item.id"
        >
          {{ item.label }}<span v-if="item.count">{{ item.count }}</span>
        </button>
        <button
          v-if="loading && loaded"
          type="button"
          class="refresh-link"
          :disabled="loading"
          @click="load"
        >
          <RefreshCw :size="15" :class="{ spinning: loading }" />刷新中
        </button>
      </div>

      <p v-if="!loaded && loading" class="muted">正在读取仪器…</p>
      <p v-else-if="!devices.length" class="muted">
        尚未有采集电脑申请接入。请在采集电脑上填写仪器类型与编号并保存。
      </p>
      <p v-else-if="!visible.length" class="muted">此筛选下没有仪器。</p>

      <div v-else class="table-wrap">
        <table class="device-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>类型</th>
              <th>名称</th>
              <th>位置</th>
              <th>状态</th>
              <th>最后联系</th>
              <th>待传</th>
              <th>版本</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="device in visible" :key="device.id">
              <tr :class="['device-row', 'state-' + device.connectionState]">
                <td><span class="device-id">{{ device.instrumentId || "—" }}</span></td>
                <td>{{ typeName(device.instrumentType) }}</td>
                <td>{{ device.name || "未命名" }}</td>
                <td>{{ device.location || "—" }}</td>
                <td>
                  <span
                    class="dev-state"
                    :class="[device.connectionState, device.registrationState === 'pending' ? 'pending' : '']"
                  >{{
                    device.registrationState === "pending"
                      ? registrationLabels.pending
                      : device.registrationState === "revoked"
                        ? registrationLabels.revoked
                        : connectionLabels[device.connectionState] || "未知"
                  }}</span>
                </td>
                <td>{{ time(device.lastSeenAt) }}</td>
                <td>{{ device.pending ?? "—" }}</td>
                <td>{{ device.clientVersion || "—" }}</td>
                <td class="actions-col">
                  <button
                    v-if="device.registrationState === 'pending'"
                    class="primary small"
                    :disabled="!!busyId"
                    @click="runAction(device, 'approve')"
                  >
                    <Check :size="16" />批准
                  </button>
                  <button
                    v-if="device.registrationState === 'pending'"
                    class="small"
                    :disabled="!!busyId"
                    @click="confirmAction = { device, mode: 'reject' }"
                  >
                    <Ban :size="16" />拒绝
                  </button>
                  <template v-else-if="device.registrationState === 'revoked'">
                    <button
                      class="small"
                      :disabled="!!busyId"
                      @click="runAction(device, 'approve')"
                    >
                      <RotateCcw :size="16" />重新启用
                    </button>
                  </template>
                  <template v-else>
                    <button
                      class="small"
                      :disabled="!!busyId"
                      @click="confirmAction = { device, mode: 'revoke' }"
                    >
                      <Ban :size="16" />停用
                    </button>
                  </template>
                  <button
                    class="small icon-only"
                    aria-label="编辑名称与位置"
                    :disabled="!!busyId"
                    @click="openEditor(device)"
                  >
                    <Pencil :size="15" />
                  </button>
                  <button
                    class="small icon-only"
                    :aria-label="expanded === device.id ? '收起详情' : '展开详情'"
                    @click="toggle(device.id)"
                  >
                    <ChevronDown
                      :size="16"
                      :class="{ flipped: expanded === device.id }"
                    />
                  </button>
                </td>
              </tr>
              <tr v-if="expanded === device.id" class="device-detail-row">
                <td colspan="9">
                  <dl class="device-detail">
                    <div>
                      <dt>设备 UUID</dt>
                      <dd class="device-identifier">{{ device.id }}</dd>
                    </div>
                    <div>
                      <dt>注册状态</dt>
                      <dd>{{ registrationLabels[device.registrationState] || device.registrationState || "—" }}</dd>
                    </div>
                    <div>
                      <dt>最近接收报告</dt>
                      <dd>{{ time(device.lastReceivedAt) }}</dd>
                    </div>
                    <div>
                      <dt>最早待传</dt>
                      <dd>{{ time(device.oldestPendingAt) }}</dd>
                    </div>
                    <div>
                      <dt>离线起始</dt>
                      <dd>{{ time(device.offlineSince) }}</dd>
                    </div>
                    <div>
                      <dt>连接中</dt>
                      <dd>{{ device.connected ? "是" : "否" }}</dd>
                    </div>
                  </dl>
                  <p v-if="device.lastError" class="error-message">
                    上传错误：{{ device.lastError }}
                  </p>
                  <p v-if="device.acquisitionError" class="error-message">
                    采集错误：{{ device.acquisitionError }}
                  </p>
                  <p
                    v-if="!device.lastError && !device.acquisitionError"
                    class="muted"
                  >
                    无错误记录。
                  </p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p class="field-help">
        在线按最后联系时间判定：≤90 秒在线，≤180 秒不稳，超过则离线；无需手动重连，客户端会自动恢复。
      </p>
    </template>

    <Modal
      v-if="editor"
      title="编辑仪器信息"
      @close="!editorBusy && (editor = null)"
    >
      <p class="muted">
        仅修改中心的显示名称与位置，不影响采集电脑上的仪器编号，也不改变上传权限。
      </p>
      <form class="form-stack" @submit.prevent="saveEditor">
        <label
          >名称<input
            v-model="editorForm.name"
            required
            maxlength="128"
            autocomplete="off"
        /></label>
        <label
          >位置<input
            v-model="editorForm.location"
            maxlength="128"
            placeholder="例如：二楼实验室"
            autocomplete="off"
        /></label>
        <p v-if="editorError" class="error-message" role="alert">
          {{ editorError }}
        </p>
      </form>
      <template #footer>
        <button type="button" :disabled="editorBusy" @click="editor = null">
          取消
        </button>
        <button class="primary" :disabled="editorBusy" @click="saveEditor">
          {{ editorBusy ? "正在保存…" : "保存" }}
        </button>
      </template>
    </Modal>

    <Modal
      v-if="confirmAction"
      :title="confirmAction.mode === 'reject' ? '拒绝此接入申请？' : '停用此仪器？'"
      @close="!busyId && (confirmAction = null)"
    >
      <p v-if="confirmAction.mode === 'reject'">
        {{
          confirmAction.device.instrumentId ||
          confirmAction.device.name
        }}：拒绝后申请被移除并释放该仪器编号，采集电脑可重新提交；本地采集不受影响。
      </p>
      <p v-else>
        {{ confirmAction.device.name || confirmAction.device.instrumentId }}：停用后新上传会被拒绝，但中心已保存的报告全部保留。采集电脑本地采集不受影响，重新启用后会自动恢复补传。
      </p>
      <template #footer>
        <button :disabled="!!busyId" @click="confirmAction = null">取消</button>
        <button
          class="primary"
          :disabled="!!busyId"
          @click="runAction(confirmAction.device, 'revoke')"
        >
          {{
            busyId
              ? confirmAction.mode === "reject"
                ? "正在拒绝…"
                : "正在停用…"
              : confirmAction.mode === "reject"
                ? "拒绝申请"
                : "停用并保留数据"
          }}
        </button>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.device-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 4px 0 14px;
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  background: white;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.filter-chip span {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #eef2f5;
  color: #5b7183;
  font-size: 11px;
  text-align: center;
}
.filter-chip.active {
  border-color: #6b838b;
  background: #eef5f3;
  color: #2f5a52;
}
.filter-chip.alert span {
  background: #f6e6c8;
  color: #8b6a1f;
}
.filter-chip.bad span {
  background: #f3d9d4;
  color: #9b4139;
}
.refresh-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  background: none;
  border: 0;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.device-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.device-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #8a97a5;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.device-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #eef1f4;
  vertical-align: middle;
  white-space: nowrap;
}
.device-row.state-offline {
  background: #fdf5f3;
}
.device-row.state-unstable {
  background: #fbf7ee;
}
.device-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.actions-col {
  text-align: right;
}
.actions-col button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 6px;
  white-space: nowrap;
}
button.small {
  padding: 5px 10px;
  font-size: 12px;
  min-height: 30px;
}
button.icon-only {
  padding: 5px 8px;
}
.flipped {
  transform: rotate(180deg);
}
.device-detail-row td {
  background: #f8fafb;
  white-space: normal;
}
.device-detail {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 20px;
  margin: 4px 0 12px;
}
.device-detail dt {
  font-size: 11px;
  color: #8a97a5;
  margin-bottom: 4px;
}
.device-detail dd {
  font-size: 13px;
  color: #455e71;
  overflow-wrap: anywhere;
}
.device-identifier {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (max-width: 760px) {
  .device-detail {
    grid-template-columns: 1fr;
  }
  .device-table th:nth-child(4),
  .device-table td:nth-child(4),
  .device-table th:nth-child(8),
  .device-table td:nth-child(8) {
    display: none;
  }
}
</style>
