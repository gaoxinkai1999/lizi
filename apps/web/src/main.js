import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { cacheWarning } from "./offline-cache.js";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const build = encodeURIComponent(new URL(import.meta.url).pathname);
    navigator.serviceWorker
      .register(`/sw.js?build=${build}`, { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() =>
        cacheWarning(
          "离线应用壳未能保存；在线功能仍可使用。请联网刷新，或使用 HTTPS / 本机地址。",
        ),
      );
  });
} else if (import.meta.env.PROD) {
  cacheWarning("当前浏览器或访问地址不支持离线应用壳；在线功能不受影响。");
}

createApp(App).mount("#app");
