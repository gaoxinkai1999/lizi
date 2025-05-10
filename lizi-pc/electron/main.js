// console.log('[调试] main.js 开始执行.'); // 移除启动日志
import { app, BrowserWindow, ipcMain, dialog } from 'electron'; // 导入 Electron 模块
import path from 'path';
import { fileURLToPath } from 'url';
import { readAndParseReports } from '../src/utils/reportReader.js'; // 导入报告读取工具
import fs from 'fs';
import fsPromises from 'fs/promises'; // 导入异步文件系统模块
import chokidar from 'chokidar'; // 导入 chokidar 用于文件监控

// 在 ESM (ECMAScript Modules) 中获取 __dirname 的等效值
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win; // 主窗口实例
let dataWatcher = null; // Chokidar 文件监视器实例


// --- 配置管理 ---
const userDataPath = app.getPath('userData'); // 用户数据目录
const configPath = path.join(userDataPath, 'config.json'); // 配置文件路径
let appConfig = {}; // 应用配置对象

// 从文件加载配置
async function loadConfig() {
  try {
    const data = await fsPromises.readFile(configPath, 'utf8');
    appConfig = JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[信息] 未找到配置文件，使用默认配置。');
      appConfig = {
        dataPath: path.join(app.getAppPath(), 'reports') // 默认数据路径相对于应用根目录
      };
      await saveConfig(); // 保存默认配置
    } else {
      console.error('[错误] 加载配置失败:', error);
      // 加载失败时回退到默认配置
      appConfig = {
        dataPath: path.join(app.getAppPath(), 'reports')
      };
    }
  }
}

// 保存配置到文件
async function saveConfig() {
  try {
    // 确保目录存在
    await fsPromises.mkdir(userDataPath, { recursive: true });
    await fsPromises.writeFile(configPath, JSON.stringify(appConfig, null, 2), 'utf8');
    // console.log('[调试] 配置已保存.'); // 移除保存成功日志
  } catch (error) {
    console.error('[错误] 保存配置失败:', error);
  }
}

// --- 配置相关的 IPC 处理程序 ---
ipcMain.handle('get-data-path', async () => {
  // console.log('[调试] IPC 收到 get-data-path 请求. 返回:', appConfig.dataPath); // 移除调试日志
  return appConfig.dataPath;
});

ipcMain.handle('set-data-path', async (event, newPath) => {
  // console.log('[调试] IPC 收到 set-data-path 请求:', newPath); // 移除调试日志
  if (newPath && typeof newPath === 'string') {
    appConfig.dataPath = newPath;
    await saveConfig();
    // console.log('[调试] 数据路径已更新并保存.'); // 移除调试日志
    // 如果存在活动的监视器，则停止它。让前端触发新的监视器。
    if (dataWatcher) {
        console.log('[信息] 因数据路径变更，正在关闭当前文件监视器。');
        await dataWatcher.close();
        dataWatcher = null;
    }
    return { success: true, message: '数据目录路径已更新。' };
  } else {
    console.warn('[警告] set-data-path 收到无效路径:', newPath);
    return { success: false, message: '无效的路径。' };
  }
});

// IPC 处理程序: 打开目录选择对话框
ipcMain.handle('open-directory-dialog', async () => {
  // console.log('[调试] IPC 收到 open-directory-dialog 请求.'); // 移除调试日志
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'] // 只允许选择目录
  });
  if (!canceled && filePaths.length > 0) {
    // console.log('[调试] 目录已选择:', filePaths[0]); // 移除调试日志
    return filePaths[0];
  } else {
    // console.log('[调试] 目录选择已取消.'); // 移除调试日志
    return null;
  }
});


// 创建主窗口函数
function createWindow() {

  const isDev = process.env.NODE_ENV === 'development'; // 检查是否为开发环境

  // 开发环境和生产环境下的多个可能的 preload 脚本路径
  const possiblePaths = isDev
    ? [
        path.join(__dirname, '../electron/preload.js')
      ]
    : [
        path.join(__dirname, './preload.js'),
        path.join(__dirname, '../preload.js'),
        path.join(app.getAppPath(), 'dist-electron/preload.js'),
        path.join(process.resourcesPath, 'app.asar/dist-electron/preload.js'),
        path.join(process.resourcesPath, 'preload.js'), // 添加 extraResources 路径
        path.join(app.getPath('exe'), '../resources/preload.js') // 相对于exe的路径
      ];

  // 查找第一个存在的预加载脚本路径
  let preloadPath = null;
  for (const potentialPath of possiblePaths) {
    try {
      if (fs.existsSync(potentialPath)) {
        preloadPath = potentialPath;
        // console.log(`[调试] 找到 preload 脚本于: ${preloadPath}`); // 移除找到脚本日志
        break;
      }
    } catch (err) {
      // console.log(`[调试] 检查路径 ${potentialPath} 时出错:`, err); // 移除检查路径错误日志
    }
  }

  // 如果在所有预期位置都找不到 preload 脚本
  if (!preloadPath || !fs.existsSync(preloadPath)) {
    console.error('[错误] 未能在任何预期位置找到 preload 脚本。');
    console.log('[信息] 正在创建临时 preload 脚本作为备选。');

    // 创建临时预加载脚本内容
    const tempPreloadContent = `
      const { contextBridge, ipcRenderer } = require('electron');

      // 示例：暴露一个简单的 ping 方法给渲染进程
      contextBridge.exposeInMainWorld('electronAPI', {
        ping: () => ipcRenderer.invoke('ping'),
        // 确保 invokeReadReports 被暴露
        invokeReadReports: (...args) => ipcRenderer.invoke('read-reports', ...args),
        // Expose new IPC handlers for config
        getDataPath: () => ipcRenderer.invoke('get-data-path'),
        setDataPath: (newPath) => ipcRenderer.invoke('set-data-path', newPath),
        openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog')
      });

      console.log('临时 preload 脚本已加载。');
    `;

    const tempDir = app.getPath('temp'); // 获取系统临时目录
    preloadPath = path.join(tempDir, 'lizi-preload.js'); // 临时脚本路径

    try {
      fs.writeFileSync(preloadPath, tempPreloadContent);
      // console.log(`[调试] 已创建临时 preload 于: ${preloadPath}`); // 移除创建成功日志
    } catch (err) {
      console.error('[错误] 创建临时 preload 脚本失败:', err);
      // 如果创建临时文件也失败，使用最后的备选路径
      preloadPath = isDev
        ? path.join(__dirname, '../electron/preload.js')
        : path.join(__dirname, './preload.js');
    }
  }


  win = new BrowserWindow({
    width: 1800,
    height: 1600,
    webPreferences: {
      preload: preloadPath, // 指定预加载脚本
      contextIsolation: true, // 启用上下文隔离（推荐）
      nodeIntegration: false, // 禁用 Node.js 集成（推荐）
    }
  });

  // 开发模式下加载本地 Vite 开发服务器
  // VITE_DEV_SERVER_URL 会由 vite-plugin-electron 自动注入 (如果配置了)
  // 这里使用固定的开发服务器 URL
  if (isDev) {
    win.loadURL('http://localhost:5173/'); // 加载 Vite 开发服务器地址
    // 开发模式下自动打开开发者工具
    win.webContents.openDevTools();
  } else {
    // 生产模式下加载打包后的静态 HTML 文件
    // 路径相对于 dist-electron/main.js
    win.loadFile(path.join(__dirname, '../dist-renderer/index.html')); // 路径看起来是正确的
  }
  // 添加窗口关闭事件监听器（用于诊断）
  win.on('closed', () => {
    // console.log('[调试] 主窗口 closed 事件触发.'); // 移除关闭日志
    win = null; // 允许垃圾回收
  });
}

// Load config, create window
app.whenReady()
  .then(loadConfig)
  .then(createWindow);
// Removed automatic startDataWatcher call


// 当所有窗口都关闭时退出应用 (除 macOS 外)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { // 'darwin' 表示 macOS
    // console.log('[调试] window-all-closed 事件触发. 非 macOS 平台，调用 app.quit().'); // 移除退出日志
    app.quit();
  }
});
// 在应用退出前执行的操作
app.on('before-quit', async (event) => { // 标记为异步处理程序
  // console.log('[调试] before-quit 事件触发.'); // 移除退出前日志
  // 移除了定时器清理逻辑

  // 在退出前关闭文件监视器
  if (dataWatcher) {
    console.log('[信息] 应用退出前关闭文件监视器。');
    await dataWatcher.close();
  }
  // event.preventDefault(); // 如果需要阻止退出（例如保存未完成的工作），取消此行注释
});

// 当应用被激活时（例如点击 Dock 图标且没有窗口打开时），创建新窗口 (macOS)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC 处理程序: 让前端触发对特定日期和班次对应目录的监控
ipcMain.handle('watch-data-directory', async (event, dateStringToWatch, shift) => { // 添加 shift 参数
    // console.log(`[调试] IPC 收到 watch-data-directory 请求，日期: ${dateStringToWatch}, 班次: ${shift}`); // 移除调试日志
    // 使用前端提供的日期和班次调用 startDataWatcher
    await startDataWatcher(dateStringToWatch, shift); // 传递 shift 参数
    // 返回成功状态，如果需要可以处理 startDataWatcher 可能抛出的错误
    return { success: true };
});

// Removed scheduleWatcherUpdate function


// --- 文件系统监视器 ---
// 修改为接受 targetDateString 和 targetShift 参数
async function startDataWatcher(targetDateString, targetShift) {
  // 移除了定时器清理逻辑

  // 如果已有监视器在运行，先关闭它
  if (dataWatcher) {
    console.log('[信息] 关闭现有的文件监视器。');
    await dataWatcher.close();
    dataWatcher = null;
  }

  // 检查数据路径是否已配置
  if (!appConfig.dataPath) {
    console.warn('[警告] 数据路径未配置，无法启动监视器。');
    return;
  }

  // 验证传入的日期字符串格式 (基本检查)
  if (!targetDateString || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateString)) {
      console.warn(`[警告] 提供给 startDataWatcher 的日期字符串无效或缺失: ${targetDateString}。监视器未启动。`);
      return;
  }
  // 验证班次信息
  if (!targetShift || (targetShift !== 'day' && targetShift !== 'night')) {
      console.warn(`[警告] 提供给 startDataWatcher 的班次无效或缺失: ${targetShift}。监视器未启动。`);
      return;
  }

  // --- 计算要监控的路径 ---
  const pathsToWatch = [];
  const basePath = appConfig.dataPath;
  const targetDatePath = path.join(basePath, targetDateString);
  pathsToWatch.push(targetDatePath); // 总是监控选定日期的目录

  // 如果是夜班，还需要监控次日的目录
  if (targetShift === 'night') {
      try {
          const currentDate = new Date(targetDateString);
          currentDate.setDate(currentDate.getDate() + 1); // 计算次日日期
          const nextDateString = currentDate.toISOString().split('T')[0];
          const nextDatePath = path.join(basePath, nextDateString);
          pathsToWatch.push(nextDatePath);
      } catch (e) {
          console.error(`[错误] 计算次日日期时出错 (日期: ${targetDateString}):`, e);
          // 如果计算次日出错，只监控当天
      }
  }

  console.log(`[信息] 开始监视路径 (日期: ${targetDateString}, 班次: ${targetShift}):`, pathsToWatch);

  // 确保目标目录存在 (可选，chokidar 也能处理不存在的路径)
  for (const dirPath of pathsToWatch) {
      try {
          await fsPromises.mkdir(dirPath, { recursive: true });
      } catch (mkdirError) {
          // 记录错误但继续尝试，chokidar 可能仍能工作或稍后目录被创建
          console.error(`[错误] 确保目录存在失败，如果目录一直未创建，监视器可能失败: ${dirPath}`, mkdirError);
      }
  }

  // 初始化 chokidar 监视器，传入路径数组
  dataWatcher = chokidar.watch(pathsToWatch, {
    persistent: true, // 持续监控
    ignoreInitial: true, // 忽略初始扫描时已存在的文件触发的 'add' 事件
    depth: 0, // 关键选项：设置监控深度为0，仅监控顶层目录内容，不递归子目录
    // awaitWriteFinish: { // 可选: 等待写入稳定后再触发事件
    //   stabilityThreshold: 2000, // 稳定时间阈值 (毫秒)
    //   pollInterval: 100 // 轮询间隔 (毫秒)
    // }
  });

  // 监听所有事件
  // 监听所有事件
  dataWatcher
    .on('all', (event, filePath) => {
      // 保留这个关键日志，显示监控到的事件
      console.log(`[文件监视器事件] 事件: ${event}, 路径: ${filePath}`);
      // 通知渲染进程数据目录已更改
      if (win && !win.isDestroyed()) { // 确保窗口存在且未被销毁
        win.webContents.send('data-directory-changed', { event, path: filePath });
      }
    })
    .on('error', error => console.error(`[文件监视器错误] 监视 ${pathsToWatch.join(', ')} 时出错:`, error)) // 保留错误日志，显示所有监控路径
    .on('ready', () => {
        console.log(`[文件监视器就绪] 对 ${pathsToWatch.join(', ')} 的初始扫描完成。准备接收更改。`); // 保留就绪日志，显示所有监控路径
        // 移除了对 scheduleWatcherUpdate 的调用
    });
}


// --- IPC 处理程序: 读取报告 ---
ipcMain.handle('read-reports', async (event, dateStr) => {
  // 使用已加载配置中的 dataPath
  const basePath = appConfig.dataPath || path.join(app.getAppPath(), 'reports'); // 如果配置丢失则回退到默认值
  // console.log(`IPC 收到 read-reports 请求，日期: ${dateStr}. 使用配置的基础路径: ${basePath}`); // 移除调试日志
  try {
    const reports = await readAndParseReports(basePath, dateStr);
    // console.log(`IPC 返回 ${reports.length} 条报告，日期: ${dateStr}`); // 移除调试日志
    return reports;
  } catch (error) {
    console.error(`处理 read-reports (${dateStr}) 时出错:`, error); // 保留错误日志
    // 向渲染进程抛出错误，以便它可以显示错误消息
    throw new Error(`Failed to read reports for ${dateStr}: ${error.message}`);
  }
});
