const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame && window.location.origin === "http://127.0.0.1:3210") {
  contextBridge.exposeInMainWorld(
    "liziDesktop",
    Object.freeze({
      getLocalAdminToken: () =>
        ipcRenderer.invoke("lizi:get-local-admin-token"),
      lanNetworkAdapters: () => ipcRenderer.invoke("lizi:lan-network-adapters"),
      configureLanAdapter: (parameters) =>
        ipcRenderer.invoke("lizi:configure-lan-adapter", parameters),
      restoreLanAdapter: (parameters) =>
        ipcRenderer.invoke("lizi:restore-lan-adapter", parameters),
    }),
  );
}
