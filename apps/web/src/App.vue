<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Activity,
  FileChartColumn,
  Settings2,
  UsersRound,
  LogOut,
  RefreshCw,
} from "lucide-vue-next";
import { request, localDate, setWritesAllowed } from "./api.js";
import {
  readSession,
  saveSession,
  sessionScope,
  clearReportCache,
  getCacheWarning,
} from "./offline-cache.js";
import AuthView from "./components/AuthView.vue";
import ReportsView from "./components/ReportsView.vue";
import SettingsView from "./components/SettingsView.vue";
import AccountsView from "./components/AccountsView.vue";
const ready = ref(false);
const bootError = ref("");
const initialized = ref(true);
const authenticationEnabled = ref(false);
const user = ref(null);
const today = ref(localDate());
const page = ref("reports");
const message = ref("");
const logoutBusy = ref(false);
const status = ref(null);
const statusError = ref("");
const live = ref(false);
const refreshKey = ref(0);
const verified = ref(false);
const offlineSession = ref(false);
const scope = ref("");
const dataRoot = ref(null);
const dataScope = ref("");
const transientReports = ref(false);
const initialQuery = ref(null);
const cacheMessage = ref(getCacheWarning());
const updateAvailable = ref(false);
let events, statusTimer, authTimer, stateController;
let stateSequence = 0;
let sessionGeneration = 0;
let statusPending = false;
let statePending = false;
let revision = null;
let invalidating = false;
let retryAt = 0;
let failures = 0;
const nav = computed(() => [
  { id: "reports", label: "报告", icon: FileChartColumn },
  {
    id: "settings",
    label:
      !authenticationEnabled.value || user.value?.role === "admin"
        ? "设置"
        : "状态",
    icon: Settings2,
  },
  ...(authenticationEnabled.value
    ? [{ id: "accounts", label: "账户", icon: UsersRound }]
    : []),
]);
watch(page, () => window.scrollTo({ top: 0, behavior: "instant" }), {
  flush: "post",
});
function acceptRevision(value) {
  if (value === undefined || value === null || value === revision) return;
  revision = value;
  refreshKey.value++;
}
function acceptStatus(value) {
  if (value.cacheEpoch !== undefined && dataScope.value) {
    const expectedEpoch = String(dataScope.value).match(
      /(?:^|[:.])([^:.]+)$/,
    )?.[1];
    if (expectedEpoch && String(value.cacheEpoch) !== expectedEpoch) {
      refreshState();
      return;
    }
  }
  if (value.root !== undefined && value.root !== dataRoot.value) {
    invalidateSession(new Event("lizi:data-root-changed"));
    return;
  }
  const completed =
    !value.scanning &&
    (status.value?.scanning ||
      (value.lastScan && value.lastScan !== status.value?.lastScan));
  status.value = value;
  statusError.value = "";
  const oldRevision = revision;
  acceptRevision(value.revision);
  if (completed && oldRevision === revision) refreshKey.value++;
}
async function refreshState() {
  if (statePending || invalidating || navigator.onLine === false) return;
  statePending = true;
  const wasVerified = verified.value;
  const sequence = ++stateSequence;
  stateController = new AbortController();
  try {
    const data = await request("/auth/state", {
      signal: stateController.signal,
      timeout: 10_000,
      retries: 0,
    });
    if (sequence !== stateSequence) return;
    const nextScope = await sessionScope({
      ...data,
      dataScope: data.dataScope || "",
      transientReports: Boolean(data.transientReports),
    });
    if (sequence !== stateSequence) return;
    const identityChanged =
      data.authenticationEnabled !== authenticationEnabled.value ||
      Boolean(user.value) !== Boolean(data.user) ||
      (user.value &&
        (data.user?.id !== user.value.id ||
          data.user?.role !== user.value.role));
    const topologyChanged =
      nextScope !== scope.value ||
      data.dataRoot !== dataRoot.value ||
      data.dataScope !== dataScope.value ||
      Boolean(data.transientReports) !== transientReports.value;
    const changed = identityChanged || topologyChanged;
    if (changed) {
      const hadIdentity = Boolean(scope.value || user.value);
      stopSession();
      scope.value = "";
      offlineSession.value = false;
      user.value = null;
      status.value = null;
      if (identityChanged) page.value = "reports";
      if (hadIdentity) await clearReportCache();
      if (sequence !== stateSequence) return;
    }
    authenticationEnabled.value = data.authenticationEnabled;
    initialized.value = data.initialized;
    today.value = data.today || localDate();
    user.value = data.user;
    dataRoot.value = data.dataRoot;
    dataScope.value = data.dataScope || "";
    transientReports.value = Boolean(data.transientReports);
    scope.value = nextScope;
    verified.value = true;
    offlineSession.value = false;
    setWritesAllowed(true);
    if (nextScope)
      await saveSession({
        scope: nextScope,
        dataRoot: dataRoot.value,
        dataScope: dataScope.value,
        transientReports: transientReports.value,
        authenticationEnabled: data.authenticationEnabled,
        today: today.value,
        savedAt: Date.now(),
        query: initialQuery.value,
      });
    if (sequence !== stateSequence) return;
    failures = 0;
    retryAt = 0;
    message.value = "";
    bootError.value = "";
    ready.value = true;
    if (user.value && !events && document.visibilityState === "visible")
      startSession();
    if (!wasVerified || changed) refreshKey.value++;
  } catch (error) {
    if (sequence !== stateSequence || error.name === "AbortError") return;
    failures++;
    retryAt =
      Date.now() + Math.min(120_000, 10_000 * 2 ** Math.min(failures, 4));
    networkFailure();
    if (!ready.value) bootError.value = `${error.message}。联网后可重新连接。`;
    else
      message.value =
        "服务暂不可达，正在显示已保存的报告；联网后会重新验证身份。";
  } finally {
    if (sequence === stateSequence) statePending = false;
  }
}
async function boot() {
  retryAt = 0;
  if (navigator.onLine === false && !ready.value)
    bootError.value = "当前离线，且没有可用的报告缓存。请联网后重试。";
  return refreshState();
}
function stopSession() {
  sessionGeneration++;
  events?.close();
  events = null;
  live.value = false;
  clearInterval(statusTimer);
  statusPending = false;
}
async function loadStatus() {
  if (
    !verified.value ||
    !user.value ||
    statusPending ||
    document.visibilityState !== "visible"
  )
    return;
  const generation = sessionGeneration;
  statusPending = true;
  try {
    const result = await request("/status", { timeout: 15_000, retries: 0 });
    if (generation === sessionGeneration) acceptStatus(result);
  } catch (error) {
    if (generation === sessionGeneration) statusError.value = error.message;
  } finally {
    if (generation === sessionGeneration) statusPending = false;
  }
}
function startSession() {
  stopSession();
  loadStatus();
  statusTimer = setInterval(loadStatus, 30_000);
  const source = new EventSource("/api/events", { withCredentials: true });
  events = source;
  source.onopen = () => {
    if (events === source) {
      live.value = true;
      loadStatus();
    }
  };
  source.addEventListener("data", (event) => {
    if (events !== source) return;
    try {
      acceptRevision(JSON.parse(event.data).revision);
    } catch {
      /* Ignore malformed notifications. */
    }
  });
  source.addEventListener("status", (event) => {
    if (events !== source) return;
    try {
      acceptStatus(JSON.parse(event.data));
    } catch {
      /* The next status poll can recover. */
    }
  });
  source.addEventListener("access", invalidateSession);
  source.onerror = () => {
    if (events === source) live.value = false;
  };
}
function networkFailure() {
  setWritesAllowed(false);
  verified.value = false;
  offlineSession.value = Boolean(scope.value || user.value);
  stopSession();
}
async function invalidateSession(event) {
  if (invalidating) return;
  invalidating = true;
  ++stateSequence;
  stateController?.abort();
  statePending = false;
  stopSession();
  setWritesAllowed(false);
  verified.value = false;
  offlineSession.value = false;
  scope.value = "";
  dataScope.value = "";
  transientReports.value = false;
  dataRoot.value = null;
  user.value = null;
  status.value = null;
  revision = null;
  page.value = "reports";
  ready.value = false;
  if (event?.type !== "lizi:cache-invalidated") await clearReportCache();
  invalidating = false;
  boot();
}
function authenticated() {
  return invalidateSession();
}
async function logout() {
  if (!verified.value) return;
  logoutBusy.value = true;
  try {
    await request("/auth/logout", { method: "POST", body: {} });
    await invalidateSession();
  } catch (error) {
    message.value = error.message;
  } finally {
    logoutBusy.value = false;
  }
}
function resume() {
  if (document.visibilityState !== "visible") {
    stopSession();
    return;
  }
  retryAt = 0;
  refreshState();
}
function cacheWarning(event) {
  cacheMessage.value = event.detail;
}
function shellMessage(event) {
  if (event.data?.type === "lizi-shell-update") updateAvailable.value = true;
}
function reloadApp() {
  window.location.reload();
}
onMounted(async () => {
  window.addEventListener("lizi:unauthorized", invalidateSession);
  window.addEventListener("lizi:cache-invalidated", invalidateSession);
  window.addEventListener("lizi:data-root-changed", invalidateSession);
  window.addEventListener("lizi:network-failure", networkFailure);
  window.addEventListener("lizi:cache-warning", cacheWarning);
  window.addEventListener("online", resume);
  window.addEventListener("offline", networkFailure);
  document.addEventListener("visibilitychange", resume);
  navigator.serviceWorker?.addEventListener("message", shellMessage);
  const initialSequence = stateSequence;
  const cached = await readSession();
  if (cached?.scope && !invalidating && initialSequence === stateSequence) {
    scope.value = cached.scope;
    dataRoot.value = cached.dataRoot;
    dataScope.value = cached.dataScope || "";
    transientReports.value = Boolean(cached.transientReports);
    authenticationEnabled.value = cached.authenticationEnabled;
    today.value = cached.today || localDate();
    initialQuery.value = cached.query;
    offlineSession.value = true;
    ready.value = true;
  }
  boot();
  authTimer = setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() >= retryAt)
      refreshState();
  }, 30_000);
});
onUnmounted(() => {
  ++stateSequence;
  stateController?.abort();
  clearInterval(authTimer);
  stopSession();
  window.removeEventListener("lizi:unauthorized", invalidateSession);
  window.removeEventListener("lizi:cache-invalidated", invalidateSession);
  window.removeEventListener("lizi:data-root-changed", invalidateSession);
  window.removeEventListener("lizi:network-failure", networkFailure);
  window.removeEventListener("lizi:cache-warning", cacheWarning);
  window.removeEventListener("online", resume);
  window.removeEventListener("offline", networkFailure);
  document.removeEventListener("visibilitychange", resume);
  navigator.serviceWorker?.removeEventListener("message", shellMessage);
});
</script>

<template>
  <main v-if="!ready" class="boot-state" aria-live="polite">
    <Activity :size="36" />
    <h1>粒子强度报告</h1>
    <template v-if="bootError"
      ><p class="error-message">{{ bootError }}</p>
      <button @click="boot"><RefreshCw :size="18" />重新连接</button></template
    >
    <p v-else class="muted">正在连接服务…</p>
  </main>
  <AuthView
    v-else-if="authenticationEnabled && !user && !offlineSession"
    :initialized="initialized"
    :message="message"
    :offline="!verified"
    @authenticated="authenticated"
  />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#reports" @click.prevent="page = 'reports'"
        ><span class="brand-mark"><Activity :size="22" /></span
        ><span>粒子<span class="brand-sub">强度报告</span></span></a
      >
      <nav aria-label="主导航">
        <button
          v-for="item in nav"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          @click="page = item.id"
        >
          <component :is="item.icon" :size="20" /><span>{{ item.label }}</span>
        </button>
      </nav>
      <div v-if="authenticationEnabled" class="sidebar-bottom">
        <span v-if="user" class="avatar">{{
          user.username.slice(0, 1).toUpperCase()
        }}</span>
        <div v-if="user" class="user-name">
          <strong>{{ user.username }}</strong
          ><span>{{ user.role === "admin" ? "管理员" : "报告查看者" }}</span>
        </div>
        <button
          class="icon-button"
          aria-label="退出登录"
          :disabled="logoutBusy || !verified"
          @click="logout"
        >
          <LogOut :size="18" />
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <span class="mobile-brand"><Activity :size="21" />粒子</span
        ><span class="desktop-breadcrumb"
          >工作空间 <span>/</span>
          {{ nav.find((item) => item.id === page)?.label }}</span
        ><span class="connection" :class="{ offline: !live }"
          ><i />{{
            !verified
              ? "离线 / 等待验证"
              : live
                ? "实时同步"
                : "在线 · 同步重连中"
          }}</span
        >
        <button
          v-if="authenticationEnabled && user"
          class="icon-button mobile-logout"
          aria-label="退出登录"
          :disabled="logoutBusy || !verified"
          @click="logout"
        >
          <LogOut :size="18" />
        </button>
      </header>
      <div v-if="!verified" class="shell-message notice" role="status">
        仅显示此前缓存的报告，未缓存页不可离线查看。缓存不是登录凭据，设置与账户操作需联网验证。
        <button @click="boot">重新连接</button>
      </div>
      <div v-if="cacheMessage" class="shell-message notice" role="status">
        {{ cacheMessage }}
      </div>
      <div v-if="updateAvailable" class="shell-message notice" role="status">
        应用已有新版本。<button @click="reloadApp">刷新应用</button>
      </div>
      <div v-if="message" role="alert" class="shell-message error-message">
        {{ message }}
      </div>
      <main class="page-content">
        <ReportsView
          v-if="user || offlineSession"
          :key="scope"
          :cache-scope="scope"
          :data-root="dataRoot"
          :transient-reports="transientReports"
          @query-changed="initialQuery = $event"
          :initial-query="initialQuery"
          :online="verified"
          :active="page === 'reports'"
          :scan-status="status"
          v-show="page === 'reports'"
          :today="today"
          :refresh-key="refreshKey"
          :live="live"
        />
        <SettingsView
          v-if="page === 'settings' && verified && user"
          :user="user"
          :authentication-enabled="authenticationEnabled"
          :initialized="initialized"
          :status="status"
          :status-error="statusError"
          @refresh-status="loadStatus"
          @reports-changed="refreshKey++"
          @access-changed="boot"
        />
        <AccountsView
          v-if="
            authenticationEnabled && page === 'accounts' && verified && user
          "
          :user="user"
          @logout="logout"
          @user-changed="refreshState"
        />
        <section v-if="page !== 'reports' && !verified" class="state-panel">
          <h2>{{ page === "accounts" ? "账户" : "设置与状态" }}需要在线验证</h2>
          <p>
            此页不保存离线副本。为避免误操作，离线时不显示配置或账户信息，也不能提交修改。
          </p>
          <button @click="boot">重新连接</button>
        </section>
      </main>
    </div>
  </div>
</template>
