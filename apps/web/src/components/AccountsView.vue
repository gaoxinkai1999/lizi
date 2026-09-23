<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import {
  KeyRound,
  LogOut,
  Plus,
  UserRound,
  ShieldCheck,
  Pencil,
  RefreshCw,
} from "lucide-vue-next";
import { request } from "../api.js";
import Modal from "./Modal.vue";
const props = defineProps({ user: Object });
const emit = defineEmits(["logout", "user-changed"]);
const admin = computed(() => props.user.role === "admin");
const users = ref([]);
const loading = ref(false);
const loadError = ref("");
const error = ref("");
const success = ref("");
const passwordBusy = ref(false);
const password = reactive({ currentPassword: "", password: "", confirm: "" });
const editorOpen = ref(false);
const editingId = ref(null);
const editBusy = ref(false);
const editError = ref("");
const form = reactive({
  username: "",
  password: "",
  role: "viewer",
  disabled: false,
});
async function loadUsers() {
  if (!admin.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    users.value = (await request("/users")).users;
  } catch (cause) {
    loadError.value = cause.message;
  } finally {
    loading.value = false;
  }
}
async function changePassword() {
  error.value = "";
  success.value = "";
  if (password.password !== password.confirm) {
    error.value = "两次输入的新密码不一致。";
    return;
  }
  passwordBusy.value = true;
  try {
    await request("/auth/password", {
      method: "POST",
      body: {
        currentPassword: password.currentPassword,
        password: password.password,
      },
    });
    Object.assign(password, { currentPassword: "", password: "", confirm: "" });
    success.value = "密码已更新，请在其他设备使用新密码登录。";
  } catch (cause) {
    error.value = cause.message;
  } finally {
    passwordBusy.value = false;
  }
}
function openEditor(user = null) {
  editingId.value = user?.id ?? null;
  Object.assign(form, {
    username: user?.username || "",
    password: "",
    role: user?.role || "viewer",
    disabled: user?.disabled || false,
  });
  editError.value = "";
  editorOpen.value = true;
}
function closeEditor() {
  if (!editBusy.value) {
    editorOpen.value = false;
    form.password = "";
  }
}
async function saveUser() {
  if (editBusy.value) return;
  editBusy.value = true;
  editError.value = "";
  try {
    if (editingId.value !== null) {
      const body = { role: form.role, disabled: form.disabled };
      if (form.password) body.password = form.password;
      await request(`/users/${encodeURIComponent(editingId.value)}`, {
        method: "PATCH",
        body,
      });
      if (editingId.value === props.user.id) {
        const state = await request("/auth/state");
        if (!state.user) {
          form.password = "";
          window.dispatchEvent(new Event("lizi:unauthorized"));
          return;
        }
        emit("user-changed", state.user);
      }
    } else {
      await request("/users", {
        method: "POST",
        body: {
          username: form.username.trim(),
          password: form.password,
          role: form.role,
        },
      });
    }
    form.password = "";
    editorOpen.value = false;
    success.value =
      editingId.value !== null ? "账户已更新。" : "新账户已创建。";
    await loadUsers();
  } catch (cause) {
    editError.value = cause.message;
  } finally {
    editBusy.value = false;
  }
}
onMounted(loadUsers);
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <p class="eyebrow">ACCOUNT</p>
        <h1>账户</h1>
        <p class="muted">管理个人安全{{ admin ? "与团队访问权限" : "" }}。</p>
      </div>
    </div>
    <section class="settings-section profile-section">
      <span class="profile-avatar"><UserRound :size="26" /></span>
      <div class="profile-info">
        <h2>{{ user.username }}</h2>
        <p class="muted">
          {{
            admin
              ? "管理员 · 可管理系统和所有账户"
              : "报告查看者 · 可查询、导出和分享报告"
          }}
        </p>
      </div>
      <button @click="emit('logout')"><LogOut :size="17" />退出登录</button>
    </section>
    <p v-if="success" class="success-message" role="status">{{ success }}</p>
    <section class="settings-section">
      <div class="section-heading">
        <KeyRound :size="21" />
        <div>
          <h2>修改密码</h2>
          <p>使用至少 12 个字符的独立密码。</p>
        </div>
      </div>
      <form class="form-stack password-form" @submit.prevent="changePassword">
        <input
          class="sr-only"
          :value="user.username"
          autocomplete="username"
          aria-label="用户名"
          readonly
        /><label
          >当前密码<input
            v-model="password.currentPassword"
            type="password"
            autocomplete="current-password"
            required
        /></label>
        <div class="form-columns">
          <label
            >新密码<input
              v-model="password.password"
              type="password"
              autocomplete="new-password"
              minlength="12"
              required /></label
          ><label
            >确认新密码<input
              v-model="password.confirm"
              type="password"
              autocomplete="new-password"
              minlength="12"
              required
          /></label>
        </div>
        <p v-if="error" role="alert" class="error-message">{{ error }}</p>
        <div>
          <button class="primary" :disabled="passwordBusy">
            {{ passwordBusy ? "正在修改…" : "更新密码" }}
          </button>
        </div>
      </form>
    </section>
    <section v-if="admin" class="settings-section">
      <div class="section-heading">
        <ShieldCheck :size="21" />
        <div>
          <h2>用户管理</h2>
          <p>权限只由账户角色决定，手机与电脑完全一致。</p>
        </div>
        <button class="primary" @click="openEditor()">
          <Plus :size="17" />添加用户
        </button>
      </div>
      <div v-if="loadError" role="alert" class="error-message">
        {{ loadError
        }}<button @click="loadUsers"><RefreshCw :size="16" />重试</button>
      </div>
      <p v-if="loading" class="muted" role="status">正在读取账户…</p>
      <div v-else class="users-list">
        <article v-for="account in users" :key="account.id" class="user-row">
          <span class="avatar light">{{
            account.username.slice(0, 1).toUpperCase()
          }}</span>
          <div class="user-row-info">
            <strong
              >{{ account.username
              }}<span v-if="account.id === user.id" class="badge"
                >当前账户</span
              ></strong
            >
            <p>
              {{ account.role === "admin" ? "管理员" : "报告查看者"
              }}<span
                class="user-enabled"
                :class="{ disabled: account.disabled }"
                >{{ account.disabled ? "已停用" : "正常" }}</span
              >
            </p>
          </div>
          <button
            :aria-label="`编辑 ${account.username}`"
            @click="openEditor(account)"
          >
            <Pencil :size="17" /><span class="edit-label">编辑</span>
          </button>
        </article>
        <p v-if="!users.length && !loadError" class="muted">暂无账户。</p>
      </div>
    </section>
    <Modal
      v-if="editorOpen"
      :title="editingId !== null ? '编辑账户' : '添加用户'"
      @close="closeEditor"
      ><form id="user-editor" class="form-stack" @submit.prevent="saveUser">
        <label
          >用户名<input
            v-model="form.username"
            minlength="3"
            maxlength="40"
            autocomplete="off"
            required
            :disabled="editingId !== null" /></label
        ><label
          >角色<select v-model="form.role">
            <option value="viewer">报告查看者</option>
            <option value="admin">管理员</option></select
          ><span class="field-help"
            >报告查看者可以查询、导出、生成图片及修改自己的密码；管理员可额外管理目录、远程访问和账户。</span
          ></label
        ><label
          >{{ editingId !== null ? "重置密码（可选）" : "初始密码"
          }}<input
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            minlength="12"
            :required="editingId === null"
            :placeholder="
              editingId !== null ? '留空保留原密码' : '至少 12 个字符'
            " /></label
        ><label v-if="editingId !== null" class="check-label"
          ><input v-model="form.disabled" type="checkbox" />停用此账户</label
        >
        <p v-if="form.disabled" class="notice">
          停用会立即终止该账户的所有登录会话。
        </p>
        <p
          v-if="editingId === user.id && form.role !== user.role"
          class="notice"
        >
          您正在修改自己的角色，保存后权限会立即更新。
        </p>
        <p v-if="editError" class="error-message" role="alert">
          {{ editError }}
        </p>
      </form>
      <template #footer
        ><button :disabled="editBusy" @click="closeEditor">取消</button
        ><button
          type="submit"
          form="user-editor"
          class="primary"
          :disabled="editBusy"
        >
          {{ editBusy ? "保存中…" : "保存账户" }}
        </button></template
      ></Modal
    >
  </section>
</template>
