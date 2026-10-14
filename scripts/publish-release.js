#!/usr/bin/env node
// Publishes a signed client installer: uploads the artifact to Tencent COS,
// verifies the anonymous download, stages it on the center, and publishes the
// release record pointing clients at object storage.
//
// Credentials come from the environment and are never written to disk:
//   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY   (COS upload)
//   LIZI_CENTER_USER / LIZI_CENTER_PASSWORD            (center admin login)
// The signing key stays external: --key <ed25519.pem> or LIZI_RELEASE_KEY.
//
// Usage:
//   node scripts/publish-release.js --file release/Lizi-Setup-3.1.3-x64.exe \
//     --notes "..." [--center https://reports.abocidee.com] \
//     [--bucket lizi-release-1317280880] [--region ap-beijing] [--skip-cos]
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  RELEASE_ARCH,
  RELEASE_PLATFORM,
  expectedReleaseFilename,
  isValidReleaseVersion,
} from "../packages/core/src/release-verification.js";
import { createCosClient, describeCosError } from "./cos-storage.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CENTER = "https://reports.abocidee.com";
const DEFAULT_BUCKET = "lizi-release-1317280880";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`无法识别的参数 ${token}`);
    const separator = token.indexOf("=");
    const name =
      separator === -1 ? token.slice(2) : token.slice(2, separator);
    let value;
    if (separator !== -1) value = token.slice(separator + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) throw new Error(`参数 --${name} 缺少取值`);
    options[name] = value;
  }
  return options;
}

function requireSetting(name, value) {
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

async function signRelease({ key, file, notes, publishedAt }) {
  const args = ["scripts/sign-release.js", "--key", key, "--file", file];
  if (notes) args.push("--notes", notes);
  if (publishedAt) args.push("--published-at", publishedAt);
  const { stdout } = await run(process.execPath, args, { cwd: path.join(here, "..") });
  return JSON.parse(stdout);
}

async function centerLogin(center, username, password) {
  const response = await fetch(`${center}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: center,
      "X-Lizi-Request": "1",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok)
    throw new Error(`中心登录失败：HTTP ${response.status} ${await response.text()}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("中心登录未返回会话 Cookie");
  return cookie;
}

async function uploadToCenter({ center, cookie, version, file, size }) {
  const response = await fetch(
    `${center}/api/releases/${encodeURIComponent(version)}/artifact`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        Cookie: cookie,
        Origin: center,
        "X-Lizi-Request": "1",
      },
      body: (await import("node:fs")).createReadStream(file),
      duplex: "half",
    },
  );
  const text = await response.text();
  if (response.status === 201 || response.status === 409) return { status: response.status, text };
  throw new Error(`安装包上传中心失败：HTTP ${response.status} ${text}`);
}

async function publishOnCenter({ center, cookie, sidecar, artifactUrl }) {
  const response = await fetch(`${center}/api/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: center,
      "X-Lizi-Request": "1",
    },
    body: JSON.stringify({
      manifest: sidecar.manifest,
      signature: sidecar.signature,
      ...(artifactUrl ? { artifactUrl } : {}),
    }),
  });
  const text = await response.text();
  if (response.status === 201) return JSON.parse(text);
  // A rerun of an already-published version is a no-op, not a failure.
  if (response.status === 409) return { skipped: true, detail: text };
  throw new Error(`中心发布失败：HTTP ${response.status} ${text}`);
}

const options = parseArguments(process.argv.slice(2));
const center = (options.center ?? DEFAULT_CENTER).replace(/\/$/, "");
const bucket = options.bucket ?? DEFAULT_BUCKET;
const region = options.region ?? process.env.TENCENTCLOUD_REGION ?? "ap-beijing";
const file = path.resolve(requireSetting("--file", options.file));
const stats = await fs.stat(file).catch(() => null);
if (!stats?.isFile()) throw new Error(`安装包不存在：${file}`);
const version = options.version ?? /^Lizi-Setup-(.+)-x64\.exe$/.exec(path.basename(file))?.[1];
if (!version || !isValidReleaseVersion(version))
  throw new Error("无法推断版本号，请使用 --version 指定 x.y.z");
if (path.basename(file) !== expectedReleaseFilename(version, RELEASE_ARCH))
  throw new Error(`安装包文件名必须为 ${expectedReleaseFilename(version, RELEASE_ARCH)}`);
if (RELEASE_PLATFORM !== "win32") throw new Error("仅支持发布 Windows x64 安装包");

const key = options.key ?? process.env.LIZI_RELEASE_KEY;
const sidecarPath = `${file}.release.json`;
let sidecar;
if (options["skip-sign"] === "1" && (await fs.stat(sidecarPath).catch(() => null))) {
  sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
} else {
  sidecar = await signRelease({
    key: requireSetting("--key 或 LIZI_RELEASE_KEY", key),
    file,
    notes: options.notes ?? "",
    publishedAt: options["published-at"],
  });
}

let objectUrl = null;
if (options["skip-cos"] !== "1") {
  const cos = createCosClient({ bucket, region });
  const objectKey = `releases/${sidecar.manifest.filename}`;
  const uploaded = await cos.uploadFile(objectKey, file, { size: sidecar.manifest.size });
  if (uploaded.status !== 200)
    throw new Error(`COS 上传失败：${describeCosError(uploaded)}`);
  objectUrl = cos.objectUrl(objectKey);
  // Prove the link works anonymously before any client depends on it.
  const probe = await fetch(objectUrl, { headers: { Range: "bytes=0-0" } });
  if (!probe.ok || !probe.headers.get("content-range"))
    throw new Error(`COS 匿名校验失败：HTTP ${probe.status}`);
  console.log(`COS 上传完成：${objectUrl}`);
}

const cookie = await centerLogin(
  center,
  requireSetting("LIZI_CENTER_USER", process.env.LIZI_CENTER_USER),
  requireSetting("LIZI_CENTER_PASSWORD", process.env.LIZI_CENTER_PASSWORD),
);
console.log(`中心登录成功：${center}`);
const staged = await uploadToCenter({
  center,
  cookie,
  version,
  file,
  size: sidecar.manifest.size,
});
console.log(`中心暂存安装包：HTTP ${staged.status}`);
const published = await publishOnCenter({ center, cookie, sidecar, artifactUrl: objectUrl });
if (published.skipped) {
  console.log(`该版本已发布，未重复发布：${published.detail.trim()}`);
} else {
  console.log(
    `发布完成：${published.release.version} → ${published.release.url}`,
  );
}
console.log(
  JSON.stringify(
    {
      version,
      sha256: sidecar.manifest.sha256,
      size: sidecar.manifest.size,
      url: published.release?.url ?? objectUrl,
      centerLatest: `${center}/api/releases/latest?platform=win32&arch=x64`,
    },
    null,
    2,
  ),
);
