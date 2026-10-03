<script setup>
import { onMounted, reactive, ref } from "vue";
import { Activity, ArrowRight, ShieldCheck } from "lucide-vue-next";
import { request } from "../api.js";
const props = defineProps({
  initialized: Boolean,
  message: String,
  offline: Boolean,
  deploymentMode: String,
});
const emit = defineEmits(["authenticated"]);
const form = reactive({ token: "", username: "", password: "", confirm: "" });
const busy = ref(false);
const error = ref("");
onMounted(async () => {
  if (props.deploymentMode !== "server" && !props.initialized && window.liziDesktop?.getSetupToken) {
    try {
      form.token = (await window.liziDesktop.getSetupToken()) || "";
    } catch {
      error.value =
        "无法自动读取设置令牌，请从服务的数据目录读取 setup-token.txt 并输入。";
    }
  }
});
async function submit() {
  if (busy.value || props.offline) return;
  error.value = "";
  if (!props.initialized && form.password !== form.confirm) {
    error.value = "两次输入的密码不一致。";
    return;
  }
  busy.value = true;
  try {
    const body = { username: form.username.trim(), password: form.password };
    if (!props.initialized) body.token = form.token.trim();
    const result = await request(
      `/auth/${props.initialized ? "login" : "setup"}`,
      { method: "POST", body },
    );
    form.password = "";
    form.confirm = "";
    form.token = "";
    emit("authenticated", result.user);
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="auth-layout">
    <section class="auth-intro">
      <div class="brand-mark"><Activity :size="26" /></div>
      <p class="eyebrow">LIZI · 粒子强度</p>
      <h1>每一次测量，<br />清晰可见。</h1>
      <p>{{ deploymentMode === "server" ? "登录中心服务器，查看各采集设备已上传的报告。" : "本地采集与查看，按需汇总和上传报告。" }}</p>
      <div class="auth-caption">
        <ShieldCheck :size="18" /> 账户保护 · {{ deploymentMode === "server" ? "集中查看" : "本地数据" }} · 独立保存
      </div>
    </section>
    <section class="auth-card">
      <p class="eyebrow">{{ initialized ? "欢迎回来" : "首次使用" }}</p>
      <h2>{{ initialized ? "登录粒子" : "创建管理员账户" }}</h2>
      <p class="muted">
        {{
          initialized
            ? "使用您的账户查看和导出报告。"
            : "设置只需一次，之后可在账户页添加成员。"
        }}
      </p>
      <p v-if="message" class="notice">{{ message }}</p>
      <p v-if="offline" class="notice">
        离线时不能登录或创建账户，请联网后重试。
      </p>
      <form class="form-stack" @submit.prevent="submit">
        <label v-if="!initialized"
          >设置令牌<input
            v-model="form.token"
            type="password"
            autocomplete="off"
            required
          /><span class="field-help"
            >{{ deploymentMode === "server" ? "请向服务器管理员获取服务数据目录 setup-token.txt 中的设置令牌。" : "令牌位于服务数据目录的 setup-token.txt。本机桌面会自动读取。" }}</span
          ></label
        >
        <label
          >用户名<input
            v-model="form.username"
            autocomplete="username"
            minlength="3"
            maxlength="40"
            required
            autofocus
            placeholder="输入用户名"
        /></label>
        <label
          >密码<input
            v-model="form.password"
            type="password"
            :autocomplete="initialized ? 'current-password' : 'new-password'"
            :minlength="initialized ? undefined : 12"
            required
            placeholder="输入密码"
          /><span v-if="!initialized" class="field-help"
            >至少 12 个字符，建议使用独立的长密码。</span
          ></label
        >
        <label v-if="!initialized"
          >确认密码<input
            v-model="form.confirm"
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
        /></label>
        <p v-if="error" role="alert" class="error-message">{{ error }}</p>
        <button class="primary" :disabled="busy || offline">
          {{ busy ? "请稍候…" : initialized ? "登录" : "创建并登录"
          }}<ArrowRight :size="18" />
        </button>
      </form>
    </section>
  </main>
</template>
