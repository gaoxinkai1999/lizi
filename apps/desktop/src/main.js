import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  dialog,
  shell,
} from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const origin = "http://127.0.0.1:3210";
const home =
  process.env.LIZI_HOME ||
  (app.isPackaged
    ? join(process.env.ProgramData || "C:\\ProgramData", "Lizi")
    : resolve(here, "../../../.lizi"));
let window;
let tray;
let quitting = false;
let loading = false;
let retryTimer;

function isTrusted(url) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function icon() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 240;
      const letter =
        (x >= 10 && x <= 14 && y >= 7 && y <= 24) ||
        (y >= 20 && y <= 24 && x >= 10 && x <= 24);
      pixels[offset] = letter ? 255 : 210;
      pixels[offset + 1] = letter ? 255 : 119;
      pixels[offset + 2] = letter ? 255 : 31;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  return nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}

const waitingPage = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>粒子报告</title><style>body{font:16px system-ui;background:#f4f7fb;color:#20304a;display:grid;place-items:center;height:95vh}main{max-width:540px;padding:40px;background:white;border-radius:20px;box-shadow:0 12px 60px #20304a12}h1{font-size:26px}p{line-height:1.9;color:#607086}code{background:#f4f7fb;padding:3px 6px}</style><main><h1>正在连接后台服务</h1><p>后台独立运行，关闭此窗口不会停止采集。首次启动可能需要几秒钟，本页会自动重试。</p><p>若一直无法连接，请在 Windows 服务中确认 <code>LiziService</code> 已启动；开发模式请先运行 <code>npm run start</code>。</p></main></html>`;

async function connect() {
  if (loading || !window || window.isDestroyed() || quitting) return;
  loading = true;
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok || (await response.json()).ok !== true)
      throw new Error("后台尚未就绪");
    await window.loadURL(origin);
    clearInterval(retryTimer);
    retryTimer = null;
  } catch {
    if (!retryTimer) retryTimer = setInterval(connect, 2500);
  } finally {
    loading = false;
  }
}

function showWindow() {
  if (!window || window.isDestroyed()) createWindow();
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: "粒子报告",
    backgroundColor: "#f4f7fb",
    icon: icon(),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "https:" && !target.username && !target.password)
        void shell.openExternal(target.href);
    } catch {
      /* Invalid external URLs are not opened. */
    }
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", () => {
    void connect();
  });
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents === window?.webContents &&
          isTrusted(details.requestingUrl) &&
          permission === "clipboard-sanitized-write",
      );
    },
  );
  window.webContents.session.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "保存报告",
      defaultPath: join(app.getPath("downloads"), item.getFilename()),
    });
  });
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(waitingPage)}`)
    .then(() => {
      if (!process.argv.includes("--hidden")) window.show();
      void connect();
    });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(retryTimer);
  });
  app.on("window-all-closed", () => {
    /* The tray owns the desktop lifetime, not the service. */
  });
  app.on("activate", showWindow);
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("com.lizi.reports");
      if (app.isPackaged) {
        const preferences = join(
          app.getPath("userData"),
          "desktop-initialized",
        );
        try {
          await readFile(preferences);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          app.setLoginItemSettings({
            openAtLogin: true,
            path: process.execPath,
            args: ["--hidden"],
          });
          await mkdir(app.getPath("userData"), { recursive: true });
          await writeFile(preferences, "1", { mode: 0o600 });
        }
      }
      ipcMain.handle("lizi:get-setup-token", async (event) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !isTrusted(event.senderFrame.url)
        )
          throw new Error("不可信的页面");
        const response = await fetch(`${origin}/api/auth/state`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok || (await response.json()).initialized) return null;
        try {
          return (await readFile(join(home, "setup-token.txt"), "utf8")).trim();
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw new Error("无法读取本机初始化凭据，请联系安装管理员");
        }
      });
      createWindow();
      tray = new Tray(icon());
      tray.setToolTip("粒子报告 · 后台持续运行");
      const refreshMenu = () => {
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "打开粒子报告", click: showWindow },
            {
              label: "登录时启动桌面",
              type: "checkbox",
              checked: app.getLoginItemSettings({
                path: process.execPath,
                args: ["--hidden"],
              }).openAtLogin,
              enabled: app.isPackaged,
              click: (item) => {
                app.setLoginItemSettings({
                  openAtLogin: item.checked,
                  path: process.execPath,
                  args: ["--hidden"],
                });
                refreshMenu();
              },
            },
            {
              label: "后台日志位置",
              click: () => {
                void dialog.showMessageBox({
                  type: "info",
                  title: "后台日志",
                  message: join(home, "logs"),
                  detail: "日志仅管理员可读取，请使用管理员权限打开此目录。",
                });
              },
            },
            { type: "separator" },
            { label: "退出桌面（后台继续运行）", click: () => app.quit() },
          ]),
        );
      };
      refreshMenu();
      tray.on("double-click", showWindow);
      tray.on("click", showWindow);
    })
    .catch((error) => {
      dialog.showErrorBox("粒子报告启动失败", error.message);
      app.quit();
    });
}
