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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
let waitingForBackend = false;
let networkOperation = false;
const executeFile = promisify(execFile);

function assertTrustedSender(event) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isTrusted(event.senderFrame.url)
  )
    throw new Error("不可信的页面");
}

function lanScriptPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "service-scripts", "Configure-Lan.ps1")
    : resolve(here, "../../../scripts/windows/Configure-Lan.ps1");
}

function powershellPath() {
  if (process.platform !== "win32")
    throw new Error("直连网卡向导仅支持 Windows");
  return join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function lanNetworkAdapters() {
  try {
    const { stdout } = await executeFile(
      powershellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        lanScriptPath(),
        "-Action",
        "List",
      ],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
      },
    );
    const adapters = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(adapters)) throw new Error("Invalid adapter list");
    return adapters;
  } catch {
    throw new Error("无法读取物理以太网网卡，请检查 Windows 网络管理组件");
  }
}

const networkErrors = {
  10: "所选网卡不可用或不是物理以太网网卡，未进行配置",
  11: "所选网卡有默认路由，不能用作隔离直连网卡",
  12: "所选网卡已使用静态 IPv4，为避免破坏原设置已拒绝操作",
  13: "所选网卡已有其他 IPv4 设置，为避免破坏原设置已拒绝操作",
  14: "所选网卡已有 DNS 设置，为避免破坏原设置已拒绝操作",
  15: "其他网卡的地址或路由与 192.168.250.0/24 重叠，请选择其他直连方案",
  16: "没有匹配此网卡的安全恢复记录，或网卡配置已变化；未删除其他配置",
  17: "此网卡已有直连恢复记录，请先恢复自动 IP",
  18: "直连地址冲突或未就绪，已恢复原自动 IP 设置",
  19: "其他直连网卡操作正在进行，请稍后重试",
  20: "配置失败且自动回滚未完成；已保留恢复记录，请再次使用恢复自动 IP，必要时联系管理员",
};

async function changeLanAdapter(event, parameters, restore = false) {
  assertTrustedSender(event);
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    Object.keys(parameters).sort().join(",") !==
      (restore ? "interfaceIndex" : "interfaceIndex,role") ||
    !Number.isInteger(parameters.interfaceIndex) ||
    parameters.interfaceIndex < 1 ||
    parameters.interfaceIndex > 2147483647 ||
    (!restore && !["host", "collector"].includes(parameters.role))
  ) {
    throw new Error("无效的网卡参数");
  }
  if (!app.isPackaged)
    throw new Error("请使用已安装的桌面应用配置网卡；开发模式仅提供只读枚举");
  if (networkOperation) throw new Error("网卡操作正在进行，请等待完成");
  networkOperation = true;
  try {
    const adapter = (await lanNetworkAdapters()).find(
      (item) => item.interfaceIndex === parameters.interfaceIndex,
    );
    if (!adapter) throw new Error("所选物理以太网网卡已不存在");
    if (
      restore
        ? !adapter.canRestore
        : !adapter.dhcpEnabled ||
          adapter.hasDefaultRoute ||
          adapter.hasNonApipaIPv4
    ) {
      throw new Error(
        restore
          ? "此网卡没有可恢复的直连记录"
          : "请选择启用 DHCP、无默认路由且没有非 APIPA 地址的物理以太网网卡",
      );
    }
    const address =
      parameters.role === "host" ? "192.168.250.1" : "192.168.250.2";
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: restore ? "恢复自动 IP" : "配置专用直连网卡",
      message: restore
        ? `恢复“${adapter.name}”的自动 IP？`
        : `将“${adapter.name}”配置为${parameters.role === "host" ? "主机 A" : "采集端 B"}直连网卡？`,
      detail: restore
        ? "仅删除本向导在同一物理网卡设置的直连地址并重新启用 DHCP。无 DHCP 服务器时由 Windows 自动生成 APIPA 地址；不会删除其他静态地址、网关或 DNS。随后将请求 Windows 管理员授权（UAC）。"
        : `请确认此网卡仅用网线连接另一台电脑，不用于上网或仪器通信。将设置 ${address}/24，不设置网关或 DNS；保存原 DHCP/APIPA 状态，失败时回滚，并可通过“恢复自动 IP”撤销。不会修改其他网卡。随后将请求 Windows 管理员授权（UAC）。这不会开启双机监听，请另在设置中选择角色。`,
      buttons: ["取消", restore ? "恢复并授权" : "配置并授权"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    assertTrustedSender(event);
    const operation = restore ? "Restore" : "Configure";
    const command = `& ${quotePowerShell(lanScriptPath())} -Action ${operation} -InterfaceIndex ${parameters.interfaceIndex}${restore ? "" : ` -Role ${parameters.role}`}; exit $LASTEXITCODE`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const elevate = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath ${quotePowerShell(powershellPath())} -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }`;
    try {
      // No timeout: never kill the helper halfway through a network transaction or rollback.
      await executeFile(
        powershellPath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(elevate, "utf16le").toString("base64"),
        ],
        { windowsHide: true, maxBuffer: 4096 },
      );
    } catch (error) {
      if (error.code === 1223) return { ok: false, cancelled: true };
      throw new Error(
        networkErrors[error.code] ||
          "网卡操作失败。请检查管理员授权及 Windows 网络状态；若有恢复记录，请使用恢复自动 IP",
      );
    }
    return { ok: true, cancelled: false };
  } finally {
    networkOperation = false;
  }
}

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

const waitingPage = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>粒子报告</title><style>body{font:16px system-ui;background:#f4f7fb;color:#20304a;display:grid;place-items:center;height:95vh}main{max-width:540px;padding:40px;background:white;border-radius:20px;box-shadow:0 12px 60px #20304a12}h1{font-size:26px}p{line-height:1.9;color:#607086}code{background:#f4f7fb;padding:3px 6px}</style><main><h1>后台暂未连接</h1><p>本窗口会自动重试。后台就绪后即可进入界面，无需等待历史报告扫描。</p><p>如果您已停止或禁用 <code>LiziService</code>，桌面不会自行重新启用它。请管理员在 Windows 服务中检查其状态；异常信息可从托盘菜单“后台日志位置”查阅。</p><p>关闭桌面窗口不会停止已经运行的后台服务。</p></main></html>`;

async function connect() {
  if (loading || !window || window.isDestroyed() || quitting) return;
  loading = true;
  try {
    if (waitingForBackend) {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok || (await response.json()).ok !== true)
        throw new Error("后台尚未就绪");
    }
    await window.loadURL(origin);
    waitingForBackend = false;
    clearInterval(retryTimer);
    retryTimer = null;
  } catch {
    if (!waitingForBackend && window && !window.isDestroyed()) {
      waitingForBackend = true;
      await window
        .loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(waitingPage)}`,
        )
        .catch(() => {});
    }
    if (!retryTimer) retryTimer = setInterval(connect, 2000);
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
  window.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) window.show();
  });
  void connect();
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
        assertTrustedSender(event);
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
      ipcMain.handle("lizi:get-local-admin-token", async (event) => {
        assertTrustedSender(event);
        try {
          return (
            await readFile(join(home, "lan-admin-token.txt"), "utf8")
          ).trim();
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw new Error("无法读取本机管理凭据，请联系安装管理员");
        }
      });
      ipcMain.handle("lizi:lan-network-adapters", async (event) => {
        assertTrustedSender(event);
        return lanNetworkAdapters();
      });
      ipcMain.handle("lizi:configure-lan-adapter", (event, parameters) =>
        changeLanAdapter(event, parameters),
      );
      ipcMain.handle("lizi:restore-lan-adapter", (event, parameters) =>
        changeLanAdapter(event, parameters, true),
      );
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
