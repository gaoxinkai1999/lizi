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
      getUpdateStatus: () => ipcRenderer.invoke("lizi:update-status"),
      checkUpdate: () => ipcRenderer.invoke("lizi:check-update"),
      downloadUpdate: () => ipcRenderer.invoke("lizi:download-update"),
      installUpdate: () => ipcRenderer.invoke("lizi:install-update"),
      onUpdateStatus: (callback) => {
        if (typeof callback !== "function") return () => {};
        const listener = (_event, status) => callback(status);
        ipcRenderer.on("lizi:update-status", listener);
        return () => ipcRenderer.removeListener("lizi:update-status", listener);
      },
    }),
  );
}
