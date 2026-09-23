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
import { request, localDate } from "./api.js";
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
let events, statusTimer, eventTimer, authTimer;
let stateSequence = 0;
let sessionGeneration = 0;
let statusPending = false;
const nav = computed(() => [
  { id: "reports", label: "报告", icon: FileChartColumn },
  {
    id: "settings",
    label: user.value?.role === "admin" ? "设置" : "状态",
    icon: Settings2,
  },
  ...(authenticationEnabled.value
    ? [{ id: "accounts", label: "账户", icon: UsersRound }]
    : []),
]);
watch(page, () => window.scrollTo({ top: 0, behavior: "instant" }), {
  flush: "post",
});
async function refreshState({ reset = false, expired = false } = {}) {
  const sequence = ++stateSequence;
  const previousUser = user.value;
  if (reset) {
    stopSession();
    ready.value = false;
    status.value = null;
    statusError.value = "";
    bootError.value = "";
  }
  try {
    const data = await request("/auth/state");
    if (sequence !== stateSequence) return;
    const changed =
      data.authenticationEnabled !== authenticationEnabled.value ||
      data.user?.id !== user.value?.id ||
      data.user?.role !== user.value?.role;
    if (changed) {
      stopSession();
      status.value = null;
      statusError.value = "";
      page.value = "reports";
    }
    authenticationEnabled.value = data.authenticationEnabled;
    initialized.value = data.initialized;
    today.value = data.today || localDate();
    user.value = data.user;
    message.value =
      expired && previousUser && authenticationEnabled.value && !user.value
        ? "登录已失效，请重新登录。"
        : "";
    if (user.value && !events) startSession();
    ready.value = true;
  } catch (error) {
    if (sequence !== stateSequence) return;
    if (!ready.value) bootError.value = error.message;
    else message.value = error.message;
  }
}
function boot() {
  return refreshState({ reset: true });
}
function stopSession() {
  sessionGeneration++;
  events?.close();
  events = null;
  live.value = false;
  clearInterval(statusTimer);
  clearTimeout(eventTimer);
  statusPending = false;
}
async function loadStatus() {
  if (!user.value || statusPending) return;
  const generation = sessionGeneration;
  statusPending = true;
  try {
    const result = await request("/status");
    if (generation === sessionGeneration) {
      status.value = result;
      statusError.value = "";
    }
  } catch (error) {
    if (generation === sessionGeneration) statusError.value = error.message;
  } finally {
    if (generation === sessionGeneration) statusPending = false;
  }
}
function startSession() {
  stopSession();
  loadStatus();
  statusTimer = setInterval(loadStatus, 15_000);
  const source = new EventSource("/api/events", { withCredentials: true });
  events = source;
  source.onopen = () => {
    if (events !== source) return;
    live.value = true;
    refreshKey.value++;
    loadStatus();
  };
  source.addEventListener("data", () => {
    if (events !== source) return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      refreshKey.value++;
      loadStatus();
    }, 200);
  });
  source.addEventListener("access", () => {
    if (events === source) boot();
  });
  source.onerror = () => {
    if (events !== source) return;
    live.value = false;
    // Keep EventSource's own reconnect backoff unless access actually changed.
    expireSession();
  };
}
function authenticated() {
  page.value = "reports";
  return boot();
}
function expireSession() {
  return refreshState({ expired: true });
}
async function logout() {
  logoutBusy.value = true;
  message.value = "";
  try {
    await request("/auth/logout", { method: "POST", body: {} });
    await boot();
  } catch (error) {
    message.value = error.message;
  } finally {
    logoutBusy.value = false;
  }
}
function resume() {
  if (document.visibilityState === "visible") {
    refreshState();
    if (user.value) {
      refreshKey.value++;
      loadStatus();
    }
  }
}
onMounted(() => {
  boot();
  authTimer = setInterval(() => {
    if (!user.value && ready.value) refreshState();
  }, 15_000);
  window.addEventListener("lizi:unauthorized", expireSession);
  document.addEventListener("visibilitychange", resume);
});
onUnmounted(() => {
  stateSequence++;
  clearInterval(authTimer);
  stopSession();
  window.removeEventListener("lizi:unauthorized", expireSession);
  document.removeEventListener("visibilitychange", resume);
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
    v-else-if="authenticationEnabled && !user"
    :initialized="initialized"
    :message="message"
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
        <span class="avatar">{{
          user.username.slice(0, 1).toUpperCase()
        }}</span>
        <div class="user-name">
          <strong>{{ user.username }}</strong
          ><span>{{ user.role === "admin" ? "管理员" : "报告查看者" }}</span>
        </div>
        <button
          class="icon-button"
          aria-label="退出登录"
          :disabled="logoutBusy"
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
          ><i />{{ live ? "实时同步" : "连接恢复中" }}</span
        >
      </header>
      <div v-if="message" role="alert" class="shell-message error-message">
        {{ message }}
      </div>
      <main class="page-content">
        <ReportsView
          v-show="page === 'reports'"
          :today="today"
          :refresh-key="refreshKey"
          :live="live"
        />
        <SettingsView
          v-if="page === 'settings'"
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
          v-if="authenticationEnabled && page === 'accounts'"
          :user="user"
          @logout="logout"
          @user-changed="refreshState"
        />
      </main>
    </div>
  </div>
</template>
