const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame && window.location.origin === "http://127.0.0.1:3210") {
  contextBridge.exposeInMainWorld(
    "liziDesktop",
    Object.freeze({
      getSetupToken: () => ipcRenderer.invoke("lizi:get-setup-token"),
    }),
  );
}
