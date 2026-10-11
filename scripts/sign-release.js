#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign as signData } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_ARCH,
  RELEASE_PLATFORM,
  RELEASE_PUBLIC_KEY_PEM,
  canonicalManifestBytes,
  expectedReleaseFilename,
  isValidReleaseVersion,
  validateReleaseManifest,
  verifyManifestSignature,
} from "../packages/core/src/release-verification.js";

const USAGE =
  "用法: node scripts/sign-release.js --key <ed25519-private-key.pem> --file <Lizi-Setup-x.y.z-x64.exe> [--version x.y.z] [--notes <文本>] [--out <路径>] [--published-at <ISO>]";

function fail(message) {
  console.error(`签名发布失败: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`无法识别的参数 ${token}`);
    const separator = token.indexOf("=");
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    let value;
    if (separator !== -1) value = token.slice(separator + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") fail(`参数 --${name} 缺少取值`);
    if (options[name] !== undefined) fail(`参数 --${name} 重复`);
    options[name] = value;
  }
  const unknown = Object.keys(options).filter(
    (name) =>
      !["key", "file", "version", "platform", "arch", "notes", "out", "published-at"].includes(
        name,
      ),
  );
  if (unknown.length) fail(`无法识别的参数 --${unknown[0]}`);
  return options;
}

async function hashFile(file) {
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

const options = parseArguments(process.argv.slice(2));
const keyPath = options.key ?? process.env.LIZI_RELEASE_KEY;
if (!keyPath) fail("必须通过 --key 或 LIZI_RELEASE_KEY 指定外部私钥文件");
if (!options.file) fail("必须通过 --file 指定安装包");

const artifact = path.resolve(options.file);
let stats;
try {
  stats = await fs.stat(artifact);
} catch {
  fail(`安装包不存在: ${artifact}`);
}
if (!stats.isFile()) fail("安装包路径不是文件");

const derivedVersion = /^Lizi-Setup-(.+)-x64\.exe$/.exec(path.basename(artifact))?.[1];
const version = options.version ?? derivedVersion;
if (!version || !isValidReleaseVersion(version))
  fail("无法从文件名推断版本，请使用 --version 指定 x.y.z");
const platform = options.platform ?? RELEASE_PLATFORM;
const arch = options.arch ?? RELEASE_ARCH;
if (platform !== RELEASE_PLATFORM || arch !== RELEASE_ARCH)
  fail("仅支持发布 Windows x64 安装包");
const filename = expectedReleaseFilename(version, arch);
if (path.basename(artifact) !== filename)
  fail(`安装包文件名必须为 ${filename}`);
const publishedAt = options["published-at"] ?? new Date().toISOString();

const { size, sha256 } = await hashFile(artifact);
const manifest = validateReleaseManifest({
  version,
  platform,
  arch,
  filename,
  size,
  sha256,
  publishedAt,
  notes: options.notes ?? "",
});

let privateKeyInput;
try {
  privateKeyInput = await fs.readFile(keyPath, "utf8");
} catch {
  fail(`无法读取私钥文件: ${keyPath}`);
}
let privateKey;
try {
  privateKey = createPrivateKey(privateKeyInput);
} catch {
  fail("私钥文件不是有效的 PEM/DER 私钥");
}
if (privateKey.asymmetricKeyType !== "ed25519")
  fail("私钥必须为 Ed25519 密钥");
const derivedPublicKey = createPublicKey(privateKey).export({
  type: "spki",
  format: "pem",
});
if (derivedPublicKey.trim() !== RELEASE_PUBLIC_KEY_PEM.trim())
  fail("私钥与内置发布公钥不匹配，发布将无法通过客户端校验");
privateKeyInput = undefined;

const signature = signData(null, canonicalManifestBytes(manifest), privateKey).toString(
  "base64",
);
if (!verifyManifestSignature(manifest, signature, RELEASE_PUBLIC_KEY_PEM))
  fail("签名自检失败");

const outPath = path.resolve(options.out ?? `${artifact}.release.json`);
const sidecar = { manifest, signature };
await fs.writeFile(outPath, `${JSON.stringify(sidecar, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(
  JSON.stringify({ ...sidecar, artifact, out: outPath }, null, 2),
);
