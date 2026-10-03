<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Network,
  RefreshCw,
  Link,
  Unplug,
  ShieldCheck,
  Search,
} from "lucide-vue-next";
import { request } from "../api.js";
import Modal from "./Modal.vue";

const emit = defineEmits(["changed"]);
const lan = ref(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const busy = ref("");
const manualAddress = ref("");
const compared = ref("");
const name = ref("");
const mode = ref("standalone");
const disconnectOpen = ref(false);
const disconnectTarget = ref(null);
const adapters = ref([]);
const selectedAdapter = ref("");
const adapterError = ref("");
const nativeBusy = ref(false);
const now = ref(Date.now());
const canManage = computed(() => Boolean(lan.value?.canManage));
const modes = { standalone: "仅本机", host: "局域网汇总", collector: "局域网采集" };
const pairing = computed(() => lan.value?.pairing);
const pending = computed(() =>
  (pairing.value?.pending || []).filter(
    (item) => !item.expiresAt || new Date(item.expiresAt).getTime() > now.value,
  ),
);
const pairingActive = computed(
  () =>
    canManage.value &&
    (new Date(pairing.value?.openUntil || 0).getTime() > now.value ||
      pending.value.length ||
      (lan.value?.joining?.status === "pending" &&
        new Date(lan.value.joining.expiresAt).getTime() > now.value)),
);
const bridge = window.liziDesktop;
const hasNative = computed(
  () => canManage.value && typeof bridge?.lanNetworkAdapters === "function",
);
const chosenAdapter = computed(() =>
  adapters.value.find(
    (adapter) => adapter.interfaceIndex === Number(selectedAdapter.value),
  ),
);
let timer;
let disposed = false;
let controller;

function schedule() {
  clearTimeout(timer);
  if (!disposed && document.visibilityState === "visible")
    timer = setTimeout(refresh, pairingActive.value ? 1500 : 30_000);
}
async function refresh() {
  if (
    disposed ||
    loading.value ||
    busy.value ||
    document.visibilityState !== "visible"
  )
    return;
  loading.value = true;
  controller = new AbortController();
  try {
    const value = await request("/lan", {
      signal: controller.signal,
      retries: 0,
      timeout: 12_000,
      localAdmin: typeof bridge?.getLocalAdminToken === "function",
    });
    if (
      !lan.value ||
      lan.value.mode !== value.mode ||
      lan.value.name !== value.name
    ) {
      mode.value = value.mode;
      name.value = value.name || "";
    }
    lan.value = value;
    now.value = Date.now();
    if (!pending.value.some((item) => item.id === compared.value))
      compared.value = "";
    error.value = "";
  } catch (cause) {
    if (!disposed && cause.name !== "AbortError") error.value = cause.message;
  } finally {
    loading.value = false;
    schedule();
  }
}
async function mutate(label, path, method = "POST", body = {}) {
  if (!canManage.value || busy.value || loading.value) return false;
  clearTimeout(timer);
  busy.value = label;
  error.value = "";
  notice.value = "";
  try {
    const value = await request(path, {
      method,
      body,
      retries: 0,
      localAdmin: true,
    });
    if (disposed) return false;
    lan.value = value;
    mode.value = value.mode;
    name.value = value.name || "";
    now.value = Date.now();
    notice.value = "操作已完成，请以下方实际状态为准。";
    emit("changed");
    return true;
  } catch (cause) {
    if (!disposed) error.value = cause.message;
    return false;
  } finally {
    busy.value = "";
    schedule();
  }
}
function configure() {
  return mutate("configure", "/lan", "PUT", {
    mode: mode.value,
    name: name.value.trim(),
  });
}
function discover() {
  return mutate(
    "discover",
    "/lan/discover",
    "POST",
    manualAddress.value.trim() ? { address: manualAddress.value.trim() } : {},
  );
}
function join(target) {
  return mutate("join", "/lan/join", "POST", {
    address: target.address,
    port: target.port,
    fingerprint: target.fingerprint,
  });
}
async function approve(item) {
  if (compared.value !== item.id) return;
  if (
    await mutate("approve", "/lan/approve", "POST", {
      id: item.id,
      code: item.code,
    })
  )
    compared.value = "";
}
async function disconnect() {
  if (await mutate("disconnect", "/lan/peer", "DELETE", disconnectTarget.value ? { id: disconnectTarget.value.id } : {}))
    disconnectOpen.value = false;
}
async function loadAdapters() {
  if (!hasNative.value || nativeBusy.value) return;
  nativeBusy.value = true;
  adapterError.value = "";
  try {
    adapters.value = await bridge.lanNetworkAdapters();
    if (
      !adapters.value.some(
        (adapter) => adapter.interfaceIndex === Number(selectedAdapter.value),
      )
    )
      selectedAdapter.value = "";
  } catch (cause) {
    adapterError.value = cause.message;
  } finally {
    nativeBusy.value = false;
  }
}
async function changeAdapter(restore = false) {
  if (!hasNative.value || !chosenAdapter.value || nativeBusy.value) return;
  nativeBusy.value = true;
  adapterError.value = "";
  notice.value = "";
  try {
    const result = restore
      ? await bridge.restoreLanAdapter({
          interfaceIndex: chosenAdapter.value.interfaceIndex,
        })
      : await bridge.configureLanAdapter({
          interfaceIndex: chosenAdapter.value.interfaceIndex,
          role: lan.value.mode,
        });
    if (result.cancelled) notice.value = "已取消网卡操作，没有继续配置。";
    else if (result.ok)
      notice.value = restore
        ? "已恢复网卡原配置。"
        : "直连网卡已配置，请重新探测设备。";
  } catch (cause) {
    adapterError.value = cause.message;
  } finally {
    nativeBusy.value = false;
    await loadAdapters();
    await refresh();
  }
}
function visibilityChanged() {
  clearTimeout(timer);
  if (document.visibilityState === "visible") refresh();
  else controller?.abort();
}
watch(
  () => pending.value[0]?.id,
  () => {
    compared.value = "";
  },
);
onMounted(() => {
  refresh();
  document.addEventListener("visibilitychange", visibilityChanged);
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
  controller?.abort();
  document.removeEventListener("visibilitychange", visibilityChanged);
});
</script>

<template>
  <section
    class="settings-section lan-settings"
    aria-labelledby="lan-settings-title"
  >
    <div class="section-heading">
      <Network :size="21" />
      <div>
        <h2 id="lan-settings-title">局域网来源管理</h2>
        <p>本机始终独立采集。最多配对8个设备，只读取各设备的本机报告，不转发其他来源；断网不影响本机保存和查看。</p>
      </div>
      <button
        class="icon-button"
        aria-label="刷新局域网状态"
        :disabled="loading || !!busy"
        @click="refresh"
      >
        <RefreshCw :size="18" :class="{ spinning: loading }" />
      </button>
    </div>
    <p v-if="error" class="error-message" role="alert">
      {{ error }}。操作结果未知时请刷新状态，不要重复提交。
    </p>
    <p v-if="notice" class="success-message" role="status">{{ notice }}</p>
    <p v-if="!lan && !error" class="muted">正在读取局域网状态…</p>
    <template v-if="lan">
      <dl class="status-grid">
        <div>
          <dt>运行方式</dt>
          <dd>{{ modes[lan.mode] }}</dd>
        </div>
        <div>
          <dt>本机名称</dt>
          <dd>{{ lan.name || "未命名设备" }}</dd>
        </div>
        <div>
          <dt>连接</dt>
          <dd>
            <span class="status-dot" :class="{ good: lan.connected }" />{{
              lan.connected ? "有设备在线" : lan.peers?.length ? "已配对 · 当前离线" : "未配对"
            }}
          </dd>
        </div>
        <div>
          <dt>监听</dt>
          <dd>{{ lan.listening ? `TLS 端口 ${lan.port}` : "未监听" }}</dd>
        </div>
      </dl>
      <p v-if="lan.lastError" class="error-message" role="alert">
        {{ lan.lastError }}
      </p>
      <ul v-if="lan.peers?.length" class="lan-peer-list" aria-label="已配对设备">
        <li v-for="peer in lan.peers" :key="peer.id">
          <span>
            <strong>{{ peer.name || peer.id }} · {{ peer.canQuery ? "报告来源" : "获授权的查看设备" }}</strong>
            <small>{{ peer.address }}:{{ peer.port }} · {{ peer.connected ? "在线" : "离线" }}</small>
            <small v-if="peer.lastError">{{ peer.lastError }}</small>
          </span>
          <button v-if="canManage" :disabled="!!busy || loading" @click="disconnectTarget = peer; disconnectOpen = true">
            <Unplug :size="16" />移除此设备
          </button>
        </li>
      </ul>
      <p v-if="lan.peers?.length" class="field-help">离线不代表没有报告；其他来源仍可查看，来源未完整同步时禁止汇总导出。</p>
      <p v-if="!canManage" class="notice">
        此页面仅显示状态；请在服务电脑本机打开管理页面配置局域网。手机和远程页面不能配对或修改网卡。
      </p>
      <template v-if="canManage">
        <form class="form-stack lan-form" @submit.prevent="configure">
          <div class="form-columns">
            <label
              >运行方式<select v-model="mode" :disabled="!!busy">
                <option value="standalone" :disabled="!!lan.peers?.length">仅本机</option>
                <option value="host">局域网汇总</option>
                <option value="collector">局域网采集</option>
              </select></label
            >
            <label
              >设备名称<input v-model="name" maxlength="80" required
            /></label>
          </div>
          <p class="field-help">两种局域网方式均可添加来源，也可向已授权设备提供本机报告。切换为仅本机前请移除所有设备。</p>
          <div class="button-row">
            <button class="primary" :disabled="!!busy || loading">
              保存局域网设置</button
            ><button
              v-if="lan.peers?.length || lan.joining?.status === 'pending'"
              type="button"
              :disabled="!!busy || loading"
              @click="disconnectTarget = null; disconnectOpen = true"
            >
              <Unplug :size="16" />断开全部并取消配对请求
            </button>
          </div>
        </form>
        <div v-if="lan.mode !== 'standalone' && (lan.peers?.length || 0) < 8" class="lan-actions">
          <h3>添加报告来源</h3>
          <p class="field-help">
            先在来源设备打开配对窗口，再自动发现。发现失败可填设备的私网 IPv4 单独探测，不会扫描整个网段。
          </p>
          <form class="input-action" @submit.prevent="discover">
            <input
              v-model="manualAddress"
              aria-label="来源设备私网IPv4"
              inputmode="decimal"
              placeholder="可选：192.168.1.25"
            /><button :disabled="!!busy || loading">
              <Search :size="17" />发现 / 探测
            </button>
          </form>
          <ul v-if="lan.discovered?.length" class="lan-peer-list">
            <li v-for="item in lan.discovered" :key="item.id">
              <span
                ><strong>{{ item.name }}</strong
                ><small>{{ item.address }}:{{ item.port }}</small></span
              ><button
                :disabled="!!busy || loading || pairingActive || lan.peers?.some(peer => peer.id === item.id)"
                @click="join(item)"
              >
                <Link :size="16" />连接
              </button>
            </li>
          </ul>
          <p v-else class="field-help">
            尚未发现设备。请确认对方已启用局域网连接、网络地址和防火墙。
          </p>
        </div>
        <div v-if="lan.joining" class="lan-actions" role="status">
          <h3>添加来源配对请求</h3>
          <p>
            {{ lan.joining.name }} ·
            {{
              lan.joining.status === "pending"
                ? "等待来源设备核对并批准"
                : lan.joining.status
            }}
          </p>
          <p class="lan-code">{{ lan.joining.code }}</p>
          <p>
            请核对两台设备的安全码一致，再在来源设备批准。无需在此输入任何令牌。
          </p>
        </div>
        <div v-if="lan.mode !== 'standalone' && (lan.peers?.length || 0) < 8" class="lan-actions">
          <h3>授权其他设备查看本机报告</h3>
          <button
            :disabled="!!busy || loading || pairingActive"
            @click="mutate('pairing', '/lan/pairing')"
          >
            <ShieldCheck :size="17" />打开配对窗口
          </button>
          <p v-if="pairingActive" class="field-help">
            配对窗口已打开，等待查看设备请求；窗口到期会自动关闭。
          </p>
          <article v-for="item in pending" :key="item.id" class="lan-request">
            <h3>请求设备：{{ item.name }}</h3>
            <p class="lan-code">{{ item.code }}</p>
            <label class="check-label"
              ><input
                type="checkbox"
                :checked="compared === item.id"
                @change="compared = $event.target.checked ? item.id : ''"
              />我已核对两台设备的安全码一致</label
            ><button
              class="primary"
              :disabled="compared !== item.id || !!busy || loading"
              @click="approve(item)"
            >
              批准配对
            </button>
          </article>
        </div>
        <div class="lan-actions">
          <h3>本机网络地址</h3>
          <p v-for="address in lan.addresses || []" :key="address.address">
            {{ address.name }}：{{ address.address }} / {{ address.netmask }}
          </p>
          <p v-if="!lan.addresses?.length" class="muted">
            未发现可用私网地址。
          </p>
          <p class="field-help">
            各设备应处于同一局域网子网，且允许 TCP 3211 与 UDP
            3212。无需开放管理端口 3210 到局域网或公网。
          </p>
        </div>
        <details
          v-if="hasNative && lan.mode !== 'standalone'"
          class="lan-actions"
        >
          <summary>可选：网线直连网卡向导</summary>
          <p class="field-help">
            仅适用于两台设备专用网线直连，不适用于多设备交换机组网。不会默认更改 IP；确认后才申请管理员授权。
            汇总方式使用 192.168.250.1/24，采集方式使用 192.168.250.2/24，不设置网关或 DNS。
            已有非自动地址或默认网关的网卡不可配置。
          </p>
          <button :disabled="nativeBusy" @click="loadAdapters">
            读取网卡列表</button
          ><label v-if="adapters.length" class="lan-adapter"
            >选择专用网卡<select v-model="selectedAdapter">
              <option value="">请选择，不会自动选择网卡</option>
              <option
                v-for="adapter in adapters"
                :key="adapter.interfaceIndex"
                :value="adapter.interfaceIndex"
              >
                {{ adapter.name }} ·
                {{ adapter.ipv4Addresses.join("、") || "尚无 IPv4"
                }}{{ adapter.hasDefaultRoute ? " · 有默认网关" : "" }}
              </option>
            </select></label
          >
          <div v-if="chosenAdapter" class="button-row">
            <button
              :disabled="
                nativeBusy ||
                chosenAdapter.hasDefaultRoute ||
                chosenAdapter.hasNonApipaIPv4 ||
                !chosenAdapter.dhcpEnabled
              "
              @click="changeAdapter()"
            >
              确认配置为{{ modes[lan.mode] }}直连地址</button
            ><button
              v-if="chosenAdapter.canRestore"
              :disabled="nativeBusy"
              @click="changeAdapter(true)"
            >
              恢复此网卡原配置
            </button>
          </div>
          <p v-if="adapterError" class="error-message" role="alert">
            {{ adapterError }}
          </p>
        </details>
      </template>
    </template>
    <Modal
      v-if="disconnectOpen"
      :title="disconnectTarget ? `移除 ${disconnectTarget.name}？` : '断开全部局域网设备？'"
      @close="disconnectOpen = false"
      ><p>
        {{ disconnectTarget ? '仅移除此设备的连接、配对凭据和来源缓存，其他来源继续保留。' : '撤销全部连接并取消待处理配对，清除所有局域网来源缓存。' }}不会删除任何电脑的原始报告；再次连接需要重新核对安全码并批准。
      </p>
      <template #footer
        ><button :disabled="!!busy" @click="disconnectOpen = false">取消</button
        ><button
          class="primary"
          :disabled="!!busy || loading"
          @click="disconnect"
        >
          确认断开并清除配对
        </button></template
      ></Modal
    >
  </section>
</template>

<style scoped>
.lan-form {
  margin-top: 18px;
}
.lan-actions {
  border-top: 1px solid #edf0f4;
  margin-top: 22px;
  padding-top: 18px;
}
.lan-actions h3 {
  margin-bottom: 8px;
}
.lan-peer-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
}
.lan-peer-list li {
  align-items: center;
  border: 1px solid #dce3eb;
  border-radius: 8px;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  margin-top: 8px;
  padding: 10px 12px;
}
.lan-peer-list li > span {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.lan-peer-list small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.lan-request {
  margin-top: 18px;
}
.lan-request > button {
  margin-top: 12px;
}
.lan-code {
  background: #eef3f8;
  border-radius: 8px;
  color: #182a3b;
  font-size: clamp(16px, 3vw, 28px);
  font-weight: 700;
  letter-spacing: 0.06em;
  margin: 20px 0;
  padding: 14px;
  text-align: center;
  overflow-wrap: anywhere;
}
.lan-adapter {
  display: grid;
  gap: 8px;
  margin: 12px 0;
}
summary {
  cursor: pointer;
}
</style>
