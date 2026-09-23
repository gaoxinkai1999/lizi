import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootCertificates } from "node:tls";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaults = {
  enabled: false,
  url: "",
  serverAddr: "",
  serverPort: 17443,
  remotePort: 13210,
  token: "",
};

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

function validate(input, previous) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("远程配置格式不正确");
  const next = { ...previous };
  for (const key of Object.keys(defaults))
    if (Object.hasOwn(input, key)) next[key] = input[key];
  if (typeof next.enabled !== "boolean") throw invalid("启用状态必须是布尔值");
  if (typeof next.url !== "string" || next.url.length > 2048)
    throw invalid("公网地址格式不正确");
  if (next.url) {
    let url;
    try {
      url = new URL(next.url);
    } catch {
      throw invalid("请输入有效的 HTTPS 公网地址");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw invalid(
        "公网地址必须是 HTTPS 站点根地址，不得包含密码、路径或参数",
      );
    }
    next.url = url.origin;
  }
  if (
    typeof next.serverAddr !== "string" ||
    next.serverAddr.length > 253 ||
    (next.serverAddr &&
      !isIP(next.serverAddr) &&
      !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
        next.serverAddr,
      ))
  ) {
    throw invalid("穿透服务器只能填写域名或 IP 地址");
  }
  for (const key of ["serverPort", "remotePort"]) {
    if (!Number.isInteger(next[key]) || next[key] < 1024 || next[key] > 65535)
      throw invalid("端口必须是 1024–65535 的整数");
  }
  if (
    typeof next.token !== "string" ||
    next.token.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(next.token)
  )
    throw invalid("穿透密钥格式不正确");
  if (next.enabled && (!next.url || !next.serverAddr || next.token.length < 24))
    throw invalid("启用穿透需填写 HTTPS 地址、服务器和至少 24 位密钥");
  return next;
}

function protectDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    // SID-based ACLs work on localized Windows and on LocalService accounts.
    const identity = execFileSync(
      "whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true },
    );
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error("无法识别当前 Windows 安全账户");
    execFileSync(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { windowsHide: true, stdio: "pipe" },
    );
  } else chmodSync(directory, 0o700);
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function createRemoteManager({ home, port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("后台端口无效");
  const directory = join(home, "remote");
  const settingsPath = join(directory, "settings.json");
  const configPath = join(directory, "frpc.json");
  const caPath = join(directory, "ca.pem");
  const executable =
    process.env.LIZI_FRPC_PATH ||
    join(
      repository,
      "apps/desktop/resources/runtime",
      process.platform === "win32" ? "frpc.exe" : "frpc",
    );
  let settings = { ...defaults };
  let child = null;
  let restartTimer = null;
  let connected = false;
  let proxyReady = false;
  let lastError = null;
  let stopped = false;
  let generation = 0;
  let attempts = 0;
  let probing = false;

  try {
    protectDirectory(directory);
    if (existsSync(settingsPath))
      settings = validate(
        JSON.parse(readFileSync(settingsPath, "utf8")),
        defaults,
      );
  } catch (error) {
    lastError = `远程配置加载失败：${error.message}`;
  }

  const getSettings = () => {
    const { token, ...publicSettings } = settings;
    return { ...publicSettings, tokenConfigured: Boolean(token) };
  };
  const getStatus = () => ({
    enabled: settings.enabled,
    connected,
    url: settings.url,
    lastError,
  });
  const reportError = (message) => {
    connected = false;
    lastError = String(message)
      .split(settings.token || "\0")
      .join("[已隐藏]")
      .slice(0, 600);
  };

  async function probe() {
    if (probing || !child || !proxyReady || stopped) return;
    probing = true;
    const current = generation;
    try {
      const response = await fetch(`${settings.url}/api/health`, {
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        cache: "no-store",
      });
      const healthy = response.ok && (await response.json()).ok === true;
      if (current !== generation || !proxyReady || stopped) return;
      if (!healthy) throw new Error("公网健康检查未通过");
      connected = true;
      attempts = 0;
      lastError = null;
    } catch (error) {
      if (current === generation && !stopped)
        reportError(`公网连接检查失败：${error.message}`);
    } finally {
      probing = false;
    }
  }

  function scheduleRestart() {
    if (stopped || !settings.enabled || restartTimer) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6));
    restartTimer = setTimeout(() => {
      restartTimer = null;
      queue = queue.then(start).catch((error) => {
        reportError(error.message);
        scheduleRestart();
      });
    }, delay);
    restartTimer.unref();
  }

  async function terminate() {
    generation++;
    connected = false;
    proxyReady = false;
    clearTimeout(restartTimer);
    restartTimer = null;
    const previous = child;
    child = null;
    if (!previous || previous.exitCode !== null || previous.signalCode !== null)
      return;
    await new Promise((resolveStop) => {
      const timeout = setTimeout(() => previous.kill("SIGKILL"), 5000);
      previous.once("close", () => {
        clearTimeout(timeout);
        resolveStop();
      });
      previous.kill("SIGTERM");
    });
  }

  async function start() {
    if (stopped || !settings.enabled || child) return;
    protectDirectory(directory);
    // FRP enables TLS by default but does not verify certificates without trustedCaFile.
    // Only an administrator-controlled service environment can override this CA source.
    const roots = process.env.LIZI_FRP_CA_FILE
      ? readFileSync(process.env.LIZI_FRP_CA_FILE, "utf8")
      : rootCertificates.join("\n");
    await atomicWrite(caPath, roots);
    const configuration = {
      serverAddr: settings.serverAddr,
      serverPort: settings.serverPort,
      loginFailExit: false,
      auth: {
        method: "token",
        token: settings.token,
        additionalScopes: ["HeartBeats", "NewWorkConns"],
      },
      transport: {
        protocol: "tcp",
        dialServerTimeout: 10,
        heartbeatInterval: 10,
        heartbeatTimeout: 30,
        tls: {
          enable: true,
          trustedCaFile: caPath,
          serverName: settings.serverAddr,
        },
      },
      log: { to: "console", level: "info", disablePrintColor: true },
      proxies: [
        {
          name: "lizi-web",
          type: "tcp",
          localIP: "127.0.0.1",
          localPort: port,
          remotePort: settings.remotePort,
          transport: { useEncryption: true },
          healthCheck: {
            type: "http",
            path: "/api/health",
            intervalSeconds: 10,
            timeoutSeconds: 3,
            maxFailed: 3,
          },
        },
      ],
    };
    await atomicWrite(configPath, JSON.stringify(configuration, null, 2));
    if (stopped) return;
    const current = ++generation;
    const processHandle = spawn(executable, ["-c", configPath], {
      cwd: directory,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = processHandle;
    connected = false;
    proxyReady = false;
    lastError = "正在建立加密连接";
    for (const stream of [processHandle.stdout, processHandle.stderr]) {
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => {
        if (current !== generation || stopped) return;
        if (/start proxy success/i.test(line)) {
          proxyReady = true;
          void probe();
        } else if (
          /\b(error|failed|closed|disconnected|reconnect|timeout)\b/i.test(line)
        ) {
          if (
            /login.*failed|control.*closed|session.*closed|disconnected|reconnect|heartbeat.*timeout|start.*proxy.*(?:error|failed)/i.test(
              line,
            )
          )
            proxyReady = false;
          reportError(line);
        }
      });
    }
    processHandle.once("error", (error) => {
      if (current === generation)
        reportError(`frpc 启动失败：${error.message}`);
    });
    processHandle.once("close", (code, signal) => {
      if (current !== generation) return;
      child = null;
      proxyReady = false;
      const detail =
        lastError && lastError !== "正在建立加密连接" ? `${lastError}；` : "";
      reportError(`${detail}frpc 已退出（${signal || code}），将自动重连`);
      scheduleRestart();
    });
  }

  let queue = Promise.resolve()
    .then(start)
    .catch((error) => {
      reportError(error.message);
      scheduleRestart();
    });
  const monitor = setInterval(() => {
    void probe();
  }, 15000);
  monitor.unref();

  return {
    getSettings,
    getStatus,
    configure(input) {
      const operation = queue.then(async () => {
        if (stopped) throw new Error("远程管理器已关闭");
        const next = validate(input, settings);
        protectDirectory(directory);
        await atomicWrite(settingsPath, JSON.stringify(next, null, 2));
        await terminate();
        settings = next;
        attempts = 0;
        lastError = null;
        try {
          await start();
        } catch (error) {
          reportError(error.message);
          scheduleRestart();
        }
        return getSettings();
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async stop() {
      stopped = true;
      clearInterval(monitor);
      clearTimeout(restartTimer);
      await queue;
      await terminate();
    },
  };
}
