// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

// 将 Electron 的特定 API 安全地暴露给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 示例：暴露一个简单的 ping 方法 (可移除，如果未使用)
  // ping: () => ipcRenderer.invoke('ping'),
  // 暴露用于调用主进程读取报告的函数
  invokeReadReports: (...args) => ipcRenderer.invoke('read-reports', ...args),
  // 暴露用于调用主进程获取数据目录路径的函数
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  // 暴露用于调用主进程设置数据目录路径的函数
  setDataPath: (newPath) => ipcRenderer.invoke('set-data-path', newPath),
  // 暴露用于调用主进程打开目录选择对话框的函数
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
  // 暴露用于请求主进程监控指定日期和班次对应目录的函数
  watchDataDirectory: (dateString, shift) => ipcRenderer.invoke('watch-data-directory', dateString, shift),
  // 暴露用于监听主进程文件变化通知的函数
  // 参数 callback: (event, data) => void，当收到消息时调用
  onDataDirectoryChanged: (callback) => ipcRenderer.on('data-directory-changed', callback)
});

// console.log('Preload 脚本已加载。'); // 移除加载日志
