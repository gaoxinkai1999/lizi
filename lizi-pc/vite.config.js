import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import path from 'path' // 确保导入 path 模块

export default defineConfig({
  plugins: [
    vue(),
    electron({
      // --- 主进程入口文件 ---
      entry: 'electron/main.js',

      // --- Preload 脚本入口及构建配置 ---
      preload: {
        input: 'electron/preload.js',
        // 配置 Vite 构建 Preload 脚本
        vite: {
          build: {
            outDir: 'dist-electron', // 将 Preload 脚本输出到 dist-electron 目录
            minify: false, // 开发时不压缩代码，方便调试
            rollupOptions: {
              output: {
                format: 'cjs', // Preload 脚本需要 CommonJS 格式
                entryFileNames: 'preload.js' // 输出文件名为 preload.js
              }
            }
          }
        }
      },

      // --- 主进程打包配置 ---
      vite: {
        build: {
          outDir: 'dist-electron', // 将主进程脚本输出到 dist-electron 目录
          minify: false, // 开发时不压缩代码
          rollupOptions: {
            output: {
              format: 'esm', // 主进程使用 ES Module 格式
              entryFileNames: 'main.js' // 输出文件名为 main.js
            }
          }
        }
      }
    })
    // 如果存在单独的渲染器插件，请移除，因为 preload 现在由 electron 插件处理
  ],

  // 渲染进程（Vue + Vite）的构建配置
  build: {
    outDir: 'dist-renderer' // 渲染进程输出目录保持为 dist-renderer
  }
})
