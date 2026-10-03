<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { CloudUpload, RefreshCw } from "lucide-vue-next";
import { request } from "../api.js";
import Modal from "./Modal.vue";

const props = defineProps({ deploymentMode: String, user: Object, syncStatus: Object });
const server = computed(() => props.deploymentMode === "server");
const admin = computed(() => props.user?.role === "admin");
const canManage = ref(false);
const settings = ref(null);
const status = ref(null);
const uploadState = computed(() => {
  if (!status.value?.enabled) return "未启用";
  if (status.value.paused) return "已暂停，请处理错误后重试";
  return status.value.connected ? "最近连接成功" : "等待连接或重试";
});
const devices = ref([]);
const loading = ref(false);
const loaded = ref(false);
const busy = ref("");
const error = ref("");
const success = ref("");
const token = ref("");
const issuedToken = ref("");
const issuedName = ref("");
const confirmation = ref(null);
const form = reactive({ enabled: false, serverUrl: "", deviceId: "", instrumentId: "" });
const registration = reactive({ id: "", name: "", instrumentId: "" });
const history = reactive({ from: "", to: "" });
let timer;
let disposed = false;
watch(
  () => props.syncStatus,
  (value) => { if (value) status.value = value; },
  { immediate: true },
);
function time(value) {
  return value ? new Date(value).toLocaleString("zh-CN") : "暂无记录";
}
async function load(refreshForm = false) {
  if (loading.value || (server.value && !admin.value)) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await request(server.value ? "/devices" : "/sync", {
      retries: 0,
      localAdmin: !server.value,
    });
    if (disposed) return;
    if (server.value) devices.value = data.devices;
    else {
      status.value = data.status;
      canManage.value = Boolean(data.canManage && admin.value);
      if (!settings.value || refreshForm) {
        settings.value = data.settings;
        Object.assign(form, {
          enabled: data.settings.enabled,
          serverUrl: data.settings.serverUrl,
          deviceId: data.settings.deviceId,
          instrumentId: data.settings.instrumentId,
        });
      }
    }
    loaded.value = true;
  } catch (cause) {
    if (!disposed) error.value = cause.message;
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (busy.value || !canManage.value) return;
  busy.value = "save";
  error.value = "";
  success.value = "";
  const body = { ...form, serverUrl: form.serverUrl.trim(), instrumentId: form.instrumentId.trim(), instrumentType: "strength" };
  if (token.value) body.token = token.value;
  token.value = "";
  try {
    await request("/sync", { method: "PUT", body, localAdmin: true });
    success.value = "上传配置已保存。启用不代表上传完成，请查看待传数量与最近成功时间。";
    await load(true);
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
  success.value = "";
  try {
    await request("/sync/retry", { method: "POST", body: {}, localAdmin: true });
    success.value = "已请求重试；是否收到确认以下方实际状态为准。";
    await load();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function backfill() {
  if (busy.value || !canManage.value) return;
  busy.value = "backfill";
  error.value = "";
  success.value = "";
  try {
    await request("/sync/backfill", { method: "POST", body: { ...history }, localAdmin: true });
    success.value = "历史补传任务已落盘，后台分批扫描；重启后继续，不影响当天采集。";
    await load();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function createDevice() {
  if (busy.value) return;
  busy.value = "create";
  error.value = "";
  success.value = "";
  try {
    const data = await request("/devices", {
      method: "POST",
      body: { id: registration.id.trim(), name: registration.name.trim(), instrumentId: registration.instrumentId.trim(), instrumentType: "strength" },
    });
    if (disposed) return;
    issuedName.value = data.device.name;
    issuedToken.value = data.token;
    Object.assign(registration, { id: "", name: "", instrumentId: "" });
    await load();
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = "";
  }
}
async function changeDevice() {
  if (busy.value || !confirmation.value) return;
  const { device, action } = confirmation.value;
  busy.value = device.id;
  error.value = "";
  success.value = "";
  try {
    const data = await request(`/devices/${encodeURIComponent(device.id)}${action === "rotate" ? "/rotate" : ""}`, {
      method: action === "rotate" ? "POST" : "DELETE",
      body: {},
    });
    if (disposed) return;
    confirmation.value = null;
    if (action === "rotate") {
      issuedName.value = device.name;
      issuedToken.value = data.token;
    } else success.value = `已撤销 ${device.name} 的上传权限，已有报告保留。`;
    await load();
  } catch (cause) {
    error.value = cause.message;
    confirmation.value = null;
  } finally {
    busy.value = "";
  }
}
function dismissToken() {
  issuedToken.value = "";
  issuedName.value = "";
}
onMounted(() => {
  load();
  timer = setInterval(() => {
    if (!busy.value && document.visibilityState === "visible") load();
  }, 30_000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  token.value = "";
  dismissToken();
});
</script>

<template>
  <section class="settings-section">
    <div class="section-heading">
      <CloudUpload :size="21" />
      <div>
        <h2>{{ server ? "采集设备" : "中心服务器上传" }}</h2>
        <p>{{ server ? "接收各设备独立上传的报告，不依赖远程访问采集电脑。" : "只上传本机报告，局域网汇总不会重复上传。" }}</p>
      </div>
    </div>
    <p v-if="server && !admin" class="muted">设备凭据与连接状态由管理员管理。</p>
    <template v-else>
      <p v-if="error" class="error-message" role="alert">{{ error }}。下方状态可能是上次获取的数据。</p>
      <p v-if="success" class="success-message" role="status">{{ success }}</p>
      <button type="button" :disabled="loading || !!busy" @click="load(true)"><RefreshCw :size="17" />{{ loading ? "正在读取…" : "刷新配置与状态" }}</button>
      <template v-if="server">
        <p class="notice">最近在线或待传为零都不保证报告完整；请结合最后接收时间与采集电脑状态核对。状态每 30 秒更新。</p>
        <form class="form-stack" @submit.prevent="createDevice">
          <h3>注册采集设备</h3>
          <div class="form-columns">
            <label>设备 ID<input v-model="registration.id" required maxlength="36" placeholder="复制采集电脑上传设置中的设备 ID" autocomplete="off" /></label>
            <label>设备名称<input v-model="registration.name" required maxlength="128" placeholder="例如：一号采集电脑" /></label>
            <label>仪器标识<input v-model="registration.instrumentId" required maxlength="128" placeholder="与采集电脑配置一致" /></label>
            <label>仪器类型<input value="强度仪（strength）" readonly /></label>
          </div>
          <p class="field-help">请先复制客户端的设备 ID，注册后将一次性显示的令牌填入该客户端。</p>
          <div><button class="primary" :disabled="!!busy || loading">{{ busy === "create" ? "正在注册…" : "注册并生成令牌" }}</button></div>
        </form>
        <p v-if="loaded && !devices.length" class="muted">尚未注册采集设备。</p>
        <section v-for="device in devices" :key="device.id" class="settings-section">
          <h3>{{ device.name }} <span class="badge">{{ device.revoked ? "已撤销" : "允许上传" }}</span></h3>
          <dl class="status-grid">
            <div><dt>设备 ID</dt><dd class="device-identifier">{{ device.id }}</dd></div>
            <div><dt>仪器</dt><dd>{{ device.instrumentId }} · 强度仪</dd></div>
            <div><dt>最近在线</dt><dd>{{ time(device.lastSeenAt) }}</dd></div>
            <div><dt>最近接收报告</dt><dd>{{ time(device.lastReceivedAt) }}</dd></div>
            <div><dt>设备上报待传数</dt><dd>{{ device.pending ?? "未知" }}</dd></div>
            <div><dt>最早待传</dt><dd>{{ time(device.oldestPendingAt) }}</dd></div>
          </dl>
          <p v-if="device.lastError" class="error-message">{{ device.lastError }}</p>
          <div class="button-row">
            <button :disabled="!!busy || loading" @click="confirmation = { device, action: 'rotate' }">{{ device.revoked ? "重新授权并生成令牌" : "轮换令牌" }}</button>
            <button v-if="!device.revoked" :disabled="!!busy || loading" @click="confirmation = { device, action: 'revoke' }">撤销上传权限</button>
          </div>
        </section>
      </template>
      <template v-else>
        <p class="notice">无法连接中心服务器时，本地报告仍可采集、保存与查看，待网络恢复补传。网页显示在线不代表上传完成。</p>
        <p class="field-help">关闭窗口不等于停止后台服务；只有服务持续运行时才会继续采集与上传。停止服务或关机期间无法采集，重启后会核对仍在磁盘的报告，并继续补传已入队的数据。</p>
        <dl v-if="status" class="status-grid">
          <div><dt>上传状态</dt><dd>{{ uploadState }}</dd></div>
          <div><dt>待传事件</dt><dd>{{ status.queueMetricsStale ? "未知（存储异常）" : (status.pending ?? "未知") }}</dd></div>
          <div><dt>最早待传</dt><dd>{{ time(status.oldestPendingAt) }}</dd></div>
          <div><dt>最近收到上传确认</dt><dd>{{ time(status.lastSuccessAt) }}</dd></div>
          <div><dt>下次尝试</dt><dd>{{ time(status.nextAttemptAt) }}</dd></div>
          <div><dt>待补扫历史日期</dt><dd>{{ status.queueMetricsStale ? "未知" : (status.backfillPendingDays ?? 0) }}</dd></div>
        </dl>
        <p v-if="status?.lastError" class="error-message" role="alert">{{ status.lastError }}</p>
        <form v-if="settings" class="form-stack" @submit.prevent="save">
          <fieldset :disabled="!canManage || !!busy" class="sync-fields">
            <label class="check-label"><input v-model="form.enabled" type="checkbox" />启用中心服务器上传</label>
            <div class="form-columns">
              <label class="full-width">服务器 HTTPS 地址<input v-model="form.serverUrl" type="url" pattern="https://.*" :required="form.enabled" placeholder="https://reports.example.com" autocomplete="off" /></label>
              <label>本机设备 ID<input :value="form.deviceId" readonly /></label>
              <label>仪器标识<input v-model="form.instrumentId" :required="form.enabled" maxlength="128" placeholder="与服务器注册信息一致" /></label>
              <label>仪器类型<input value="强度仪（strength）" readonly /></label>
              <label>设备上传令牌<input v-model="token" type="password" autocomplete="new-password" :placeholder="settings.tokenConfigured ? '已配置，留空保留' : '输入服务器生成的设备令牌'" :required="form.enabled && !settings.tokenConfigured" /></label>
            </div>
          </fieldset>
          <p class="field-help">令牌只提交至本机服务，不写入浏览器缓存。轮换后请填入新令牌；提交后输入框会清空。</p>
          <p v-if="!canManage" class="muted">上传配置和重试仅允许本机管理员操作，请使用采集电脑的粒子桌面。</p>
          <div v-else class="button-row">
            <button class="primary" :disabled="!!busy || loading">{{ busy === "save" ? "正在保存…" : "保存上传配置" }}</button>
            <button type="button" :disabled="!!busy || loading || !status?.enabled" @click="retry">{{ busy === "retry" ? "正在请求…" : "立即重试" }}</button>
          </div>
        </form>
        <form v-if="canManage" class="form-stack" @submit.prevent="backfill">
          <h3>补传历史报告</h3>
          <p class="field-help">首次启用不会自动解析全部旧目录。需要网页查看历史报告时，选择报告目录日期范围；任务持久保存、分批处理，最多十年。已上传且未修改的报告不会重复入库。</p>
          <div class="form-columns">
            <label>起始日期<input v-model="history.from" type="date" required :max="history.to || undefined" /></label>
            <label>结束日期<input v-model="history.to" type="date" required :min="history.from || undefined" /></label>
          </div>
          <div><button :disabled="!!busy || loading || !settings?.tokenConfigured">{{ busy === 'backfill' ? '正在安排…' : '安排历史补传' }}</button></div>
        </form>
      </template>
    </template>
    <Modal v-if="issuedToken" title="请保存设备上传令牌" @close="dismissToken">
      <p>{{ issuedName }} 的令牌仅显示这一次，请复制到对应采集电脑的上传设置。关闭后无法再次读取，只能轮换。</p>
      <label class="form-stack">设备令牌<textarea :value="issuedToken" rows="3" readonly spellcheck="false" autocomplete="off" @focus="$event.target.select()" /></label>
      <p class="field-help">不要发送到公开聊天、截图或日志中。此页面不会把令牌写入浏览器存储。</p>
      <template #footer><button class="primary" @click="dismissToken">已保存，关闭显示</button></template>
    </Modal>
    <Modal v-if="confirmation" :title="confirmation.action === 'rotate' ? '生成新设备令牌？' : '撤销设备上传权限？'" @close="!busy && (confirmation = null)">
      <p>{{ confirmation.device.name }}：{{ confirmation.action === "rotate" ? "旧令牌立即失效，新令牌仅显示一次。请在采集电脑更新令牌后继续补传。" : "已有报告保留，新上传将被拒绝；本地采集不受影响。" }}</p>
      <template #footer>
        <button :disabled="!!busy" @click="confirmation = null">取消</button>
        <button class="primary" :disabled="!!busy" @click="changeDevice">{{ busy ? "正在处理…" : "确认" }}</button>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.sync-fields { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 16px; }
.device-identifier { overflow-wrap: anywhere; }
</style>
