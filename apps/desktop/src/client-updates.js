import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_TIMEOUT = 15000;
const DOWNLOAD_IDLE_TIMEOUT = 5 * 60 * 1000;
const LATEST_RESPONSE_LIMIT = 64 * 1024;

// The pinned public key and manifest canonicalisation come from the shared core
// module. Packaged builds read the copy staged under resources/backend; dev
// runs read the workspace copy directly.
export async function loadReleaseModules(app) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "packages", "core", "src")
    : path.resolve(here, "../../../packages/core/src");
  const [deployment, verification] = await Promise.all([
    import(pathToFileURL(path.join(base, "deployment.js")).href),
    import(pathToFileURL(path.join(base, "release-verification.js")).href),
  ]);
  return { deployment, verification };
}

function powershellPath() {
  if (process.platform !== "win32") throw new Error("更新安装仅支持 Windows");
  return path.join(
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

function runPowerShell(script, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

// Reads a small JSON reply with a hard byte cap so a hostile or broken center
// cannot stream an unbounded body into memory before the manifest is trusted.
export async function readBoundedJson(response, limit) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isSafeInteger(declared) && declared > limit)
    throw new Error("中心响应过大");
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("中心响应格式异常");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("中心响应过大");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

// Restricts the private download directory to the interactive user (plus SYSTEM
// and read-only Administrators for the elevated installer helper). The default
// %APPDATA% ACL already excludes other standard users; this narrows it further.
// Best effort and non-blocking: startup must not wait on PowerShell, and the
// authoritative hash check still happens inside the elevated helper.
function hardenUpdatesDirectory(directory) {
  if (process.platform !== "win32") {
    void fs.chmod(directory, 0o700).catch(() => {});
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    `$dir = ${quotePowerShell(directory)}`,
    "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))",
    "Set-Acl -Path $dir -AclObject $acl",
  ].join("; ");
  try {
    const child = execFile(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 30000 },
      (error) => {
        if (error) console.error("更新下载目录权限加固失败：", error.message);
      },
    );
    child.unref?.();
  } catch (error) {
    console.error("更新下载目录权限加固失败：", error.message);
  }
}

export function installerOutcome(code) {
  if (code === 0 || code === undefined || code === null) return { ok: true };
  if (code === 1223) return { cancelled: true };
  if (code === 11 || code === 12)
    return { ok: false, error: "安装包校验失败，已取消安装" };
  return { ok: false, error: "无法启动安装程序，请检查管理员授权是否可用" };
}

// Re-copies the verified installer into an administrator-only ProgramData
// directory, re-hashes it there, and only then launches that protected copy.
// The hash is recomputed inside the elevated helper, so replacing the file in
// the user directory between download and elevation cannot lead to execution.
async function launchProtectedInstaller({ file, size, sha256 }) {
  const destinationName = `${randomUUID()}.exe`;
  const inner = [
    "$ErrorActionPreference='Stop'",
    `$source = ${quotePowerShell(file)}`,
    `$expectedHash = '${sha256}'`,
    `$expectedSize = ${size}`,
    `$destName = ${quotePowerShell(destinationName)}`,
    "$dir = Join-Path $env:ProgramData 'LiziUpdates'",
    "if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
    "if ((Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 12 }",
    "$dacl = New-Object System.Security.AccessControl.DirectorySecurity",
    "$dacl.SetAccessRuleProtection($true,$false)",
    "$dacl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
    "$dacl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
    "$dacl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
    "Set-Acl -Path $dir -AclObject $dacl",
    "Get-ChildItem -LiteralPath $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue",
    "if ((Get-Item -LiteralPath $source).Length -ne $expectedSize) { exit 11 }",
    "if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLower() -ne $expectedHash) { exit 11 }",
    "$dest = Join-Path $dir $destName",
    "Copy-Item -LiteralPath $source -Destination $dest -Force",
    "if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -ne $expectedHash) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue; exit 12 }",
    "$facl = New-Object System.Security.AccessControl.FileSecurity",
    "$facl.SetAccessRuleProtection($true,$false)",
    "$facl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
    "$facl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'FullControl','Allow'))",
    "$facl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','Allow'))",
    "Set-Acl -Path $dest -AclObject $facl",
    "Start-Process -FilePath $dest -WindowStyle Normal -PassThru | Out-Null",
    "exit 0",
  ].join("; ");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  // Start-Process -Wait waits for the entire descendant tree, including the
  // interactive installer. Wait only for the short-lived verification helper.
  const elevate = `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath ${quotePowerShell(powershellPath())} -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }`;
  try {
    await runPowerShell(elevate);
    return installerOutcome(0);
  } catch (error) {
    return installerOutcome(typeof error.code === "number" ? error.code : 1);
  }
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on("error", reject)
      .on("end", resolve);
  });
  return { size, sha256: hash.digest("hex") };
}

class DownloadLimiter extends Transform {
  constructor(expected, onProgress) {
    super();
    this.hash = createHash("sha256");
    this.size = 0;
    this.expected = expected;
    this.onProgress = onProgress;
  }
  _transform(chunk, _encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.expected) {
      callback(new Error("安装包超过发布清单声明的大小"));
      return;
    }
    this.hash.update(chunk);
    this.onProgress(this.size);
    callback(null, chunk);
  }
  digest() {
    return this.hash.digest("hex");
  }
}

export async function createUpdateManager({
  app,
  currentVersion,
  fetchImpl = fetch,
  publicKey,
}) {
  const { deployment, verification } = await loadReleaseModules(app);
  const { CENTER_URL } = deployment;
  const {
    isNewerReleaseVersion,
    validateReleaseManifest,
    verifyManifestSignature,
  } = verification;
  // Production always uses the pinned key compiled into the core module; the
  // override exists only so verification logic can be exercised without the
  // offline signing key.
  const pinnedKey = publicKey ?? verification.RELEASE_PUBLIC_KEY_PEM;
  if (new URL(CENTER_URL).protocol !== "https:")
    throw new Error("中心地址必须为 HTTPS");
  const centerOrigin = new URL(CENTER_URL).origin;

  const updatesDirectory = path.join(app.getPath("userData"), "updates");
  await fs.mkdir(updatesDirectory, { recursive: true, mode: 0o700 });
  hardenUpdatesDirectory(updatesDirectory);

  const listeners = new Set();
  let downloaded = null;
  let busy = null;
  const status = {
    currentVersion,
    state: "idle",
    center: CENTER_URL,
    latest: null,
    downloaded: null,
    progress: null,
    ready: false,
    error: null,
    lastCheckedAt: null,
  };

  function snapshot() {
    return JSON.parse(JSON.stringify(status));
  }

  function publish() {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        /* A failing status listener must not break the update flow. */
      }
    }
  }

  function onStatus(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    publish();
    return snapshot();
  }

  function latestDescriptor(manifest) {
    return {
      version: manifest.version,
      publishedAt: manifest.publishedAt,
      notes: manifest.notes,
      size: manifest.size,
      filename: manifest.filename,
      platform: manifest.platform,
      arch: manifest.arch,
      sha256: manifest.sha256,
    };
  }

  function downloadedDescriptor() {
    return downloaded
      ? {
          version: downloaded.version,
          size: downloaded.size,
          sha256: downloaded.sha256,
        }
      : null;
  }

  async function request(url, options) {
    const response = await fetchImpl(url, { redirect: "error", ...options });
    // redirect:"error" already rejects redirects; refuse any off-origin answer
    // so a manipulated proxy cannot redirect downloads to another host.
    if (new URL(response.url).origin !== centerOrigin)
      throw new Error("中心响应来源异常");
    return response;
  }

  async function check() {
    if (busy) throw new Error("更新操作正在进行，请稍后重试");
    busy = "check";
    setStatus({ state: "checking", error: null });
    try {
      const response = await request(
        `${CENTER_URL}/api/releases/latest?platform=win32&arch=x64`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(CHECK_TIMEOUT),
        },
      );
      if (!response.ok) throw new Error(`中心返回 ${response.status}`);
      const body = await readBoundedJson(response, LATEST_RESPONSE_LIMIT);
      const release = body?.release ?? null;
      const lastCheckedAt = new Date().toISOString();
      if (!release) {
        downloaded = null;
        return setStatus({
          state: "up-to-date",
          latest: null,
          downloaded: null,
          ready: false,
          progress: null,
          lastCheckedAt,
        });
      }
      let manifest;
      try {
        manifest = validateReleaseManifest(release.manifest);
      } catch (error) {
        throw new Error(`发布清单无效：${error.message}`);
      }
      if (!verifyManifestSignature(manifest, release.signature, pinnedKey))
        throw new Error("发布签名未通过固定公钥校验");
      if (!isNewerReleaseVersion(manifest.version, currentVersion)) {
        downloaded = null;
        return setStatus({
          state: "up-to-date",
          latest: null,
          downloaded: null,
          ready: false,
          progress: null,
          lastCheckedAt,
        });
      }
      downloaded = null;
      return setStatus({
        state: "available",
        latest: latestDescriptor(manifest),
        downloaded: null,
        ready: false,
        progress: null,
        lastCheckedAt,
      });
    } catch (error) {
      return setStatus({
        state: "error",
        error: error.message || "检查更新失败",
        progress: null,
      });
    } finally {
      busy = null;
    }
  }

  function requireLatest() {
    const latest = status.latest;
    if (!latest) throw new Error("请先检查更新");
    if (!isNewerReleaseVersion(latest.version, currentVersion))
      throw new Error("当前已是最新版本，不允许重复或降级安装");
    return latest;
  }

  async function download() {
    if (busy) throw new Error("更新操作正在进行，请稍后重试");
    let latest;
    try {
      latest = requireLatest();
    } catch (error) {
      return setStatus({ state: "error", error: error.message });
    }
    busy = "download";
    status.state = "downloading";
    status.error = null;
    status.progress = { received: 0, total: latest.size, percent: 0 };
    publish();
    const temporary = path.join(
      updatesDirectory,
      `.${latest.version}-${randomUUID()}.part`,
    );
    const target = path.join(updatesDirectory, latest.filename);
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT);
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT);
    };
    const limiter = new DownloadLimiter(latest.size, (received) => {
      bumpIdle();
      status.progress = {
        received,
        total: latest.size,
        percent: Math.min(100, Math.round((received / latest.size) * 100)),
      };
      publish();
    });
    try {
      const response = await request(
        `${CENTER_URL}/api/releases/${encodeURIComponent(latest.version)}/download`,
        {
          headers: { accept: "application/octet-stream" },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`中心返回 ${response.status}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isSafeInteger(declared) && declared > 0 && declared !== latest.size)
        throw new Error("安装包长度与发布清单不一致");
      await pipeline(response.body, limiter, createWriteStream(temporary, { mode: 0o600 }));
      if (limiter.size !== latest.size)
        throw new Error("安装包长度与发布清单不一致");
      if (limiter.digest() !== latest.sha256)
        throw new Error("安装包 SHA256 与发布清单不一致");
      const handle = await fs.open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
      downloaded = {
        version: latest.version,
        size: latest.size,
        sha256: latest.sha256,
        path: target,
      };
      return setStatus({
        state: "ready",
        downloaded: downloadedDescriptor(),
        ready: true,
        progress: {
          received: latest.size,
          total: latest.size,
          percent: 100,
        },
        error: null,
      });
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      const aborted = error.name === "AbortError" || error.name === "TimeoutError";
      return setStatus({
        state: "error",
        ready: false,
        downloaded: downloadedDescriptor(),
        progress: null,
        error: aborted
          ? "下载超时或已中断，可重试"
          : error.message || "下载更新失败，可重试",
      });
    } finally {
      clearTimeout(idleTimer);
      busy = null;
    }
  }

  async function install() {
    if (busy) throw new Error("更新操作正在进行，请稍后重试");
    if (!downloaded) return setStatus({ state: "error", error: "请先下载更新" });
    if (!isNewerReleaseVersion(downloaded.version, currentVersion))
      return setStatus({
        state: "error",
        error: "当前已是最新版本，不允许重复或降级安装",
      });
    if (
      !downloaded.path ||
      path.dirname(downloaded.path) !== updatesDirectory ||
      !/^Lizi-Setup-[0-9A-Za-z.\-]+\.exe$/.test(path.basename(downloaded.path))
    )
      return setStatus({ state: "error", error: "安装包位置异常，请重新下载" });
    busy = "install";
    try {
      // Re-hash immediately before elevation: the bytes that execute must match
      // the signed manifest even if the on-disk file changed after download.
      const actual = await hashFile(downloaded.path);
      if (actual.size !== downloaded.size || actual.sha256 !== downloaded.sha256) {
        downloaded = null;
        return setStatus({
          state: "error",
          ready: false,
          downloaded: null,
          error: "安装包校验失败，请重新下载",
        });
      }
      setStatus({ state: "installing", error: null });
      // The elevated helper re-copies to ProgramData and re-hashes there, so the
      // hash computed above is only an early guard; execution uses the verified
      // administrator-only copy.
      const launched = await launchProtectedInstaller({
        file: downloaded.path,
        size: downloaded.size,
        sha256: downloaded.sha256,
      });
      if (launched.cancelled) return setStatus({ state: "ready", error: null });
      if (!launched.ok) return setStatus({ state: "error", error: launched.error });
      return setStatus({ state: "installing", error: null });
    } catch (error) {
      return setStatus({
        state: "error",
        error: error.message || "安装失败，请重试",
      });
    } finally {
      busy = null;
    }
  }

  return {
    center: CENTER_URL,
    updatesDirectory,
    getStatus: snapshot,
    onStatus,
    check,
    download,
    install,
  };
}
