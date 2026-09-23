<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { X } from "lucide-vue-next";
const props = defineProps({ title: String, wide: Boolean });
const emit = defineEmits(["close"]);
const dialog = ref(null);
let previousFocus;
onMounted(() => {
  previousFocus = document.activeElement;
  dialog.value.showModal();
});
onUnmounted(() => previousFocus?.focus?.());
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    :class="{ wide }"
    :aria-label="props.title"
    @cancel.prevent="emit('close')"
    @click="(event) => event.target === dialog && emit('close')"
  >
    <header class="modal-header">
      <h2>{{ title }}</h2>
      <button class="icon-button" aria-label="关闭窗口" @click="emit('close')">
        <X :size="21" />
      </button>
    </header>
    <div class="modal-body"><slot /></div>
    <footer v-if="$slots.footer" class="modal-footer">
      <slot name="footer" />
    </footer>
  </dialog>
</template>
