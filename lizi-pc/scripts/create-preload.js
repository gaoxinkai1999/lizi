#!/usr/bin/env node

/**
 * 自动创建 preload.js 文件
 * 在构建后自动运行，确保 dist-electron 目录中有 preload.js 文件
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 项目根目录
const rootDir = path.join(__dirname, '..');

// preload 文件目标路径
const preloadPath = path.join(rootDir, 'dist-electron', 'preload.js');
// preload 文件源路径
const sourcePreloadPath = path.join(rootDir, 'electron', 'preload.js');

// 默认 preload 文件内容 (如果源文件不存在)
const preloadContent = `// preload.js - 由 electron-builder 内置到应用中
const { contextBridge, ipcRenderer } = require('electron');

// 暴露一个简单的 ping 方法给渲染进程 (示例)
contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  // 确保 invokeReadReports 被暴露
  invokeReadReports: (...args) => ipcRenderer.invoke('read-reports', ...args)
});

console.log('Preload 脚本已从 dist-electron/preload.js 加载 - 自动生成');
`;

try {
  // 确保目标目录存在
  if (!fs.existsSync(path.dirname(preloadPath))) {
    fs.mkdirSync(path.dirname(preloadPath), { recursive: true });
  }

  // 优先尝试复制源文件
  if (fs.existsSync(sourcePreloadPath)) {
    console.log(`[构建脚本] 复制 ${sourcePreloadPath} 到 ${preloadPath}`); // 保留脚本日志
    // 读取源文件内容并替换 ES Module 导入为 CommonJS require
    let content = fs.readFileSync(sourcePreloadPath, 'utf8');
    content = content.replace(/import\s+\{\s*contextBridge,\s*ipcRenderer\s*\}\s+from\s+['"]electron['"];/g,
                            `const { contextBridge, ipcRenderer } = require('electron');`);
    fs.writeFileSync(preloadPath, content);
  } else {
    // 如果源文件不存在，则使用默认模板创建
    console.log(`[构建脚本] 源 preload.js 不存在，创建 ${preloadPath} 使用默认模板`); // 保留脚本日志
    fs.writeFileSync(preloadPath, preloadContent);
  }

  console.log(`[构建脚本] ✅ 成功创建 preload.js 文件到 ${preloadPath}`); // 保留脚本日志
} catch (error) {
  console.error(`[构建脚本] ❌ 创建 preload.js 文件失败: ${error.message}`); // 保留脚本错误日志
  process.exit(1);
}
