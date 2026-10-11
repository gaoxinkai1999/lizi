import { createPublicKey, verify as verifySignature } from "node:crypto";

// Release verification contract shared by the server (publication) and the
// desktop client (download verification). The Ed25519 public key is pinned in
// source and compiled into both sides; the private key never enters the repo or
// any running server process.
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzaBxEam5cVYjzd1Dh9+S+kTq8ZaeMpJ2V207qJAdYJI=
-----END PUBLIC KEY-----`;

export const RELEASE_MANIFEST_FIELDS = Object.freeze([
  "version",
  "platform",
  "arch",
  "filename",
  "size",
  "sha256",
  "publishedAt",
  "notes",
]);

export const RELEASE_PLATFORM = "win32";
export const RELEASE_ARCH = "x64";
export const RELEASE_NOTES_LIMIT = 2000;
export const RELEASE_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const RELEASE_VERSION_LIMIT = 32;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

export function isValidReleaseVersion(value) {
  return (
    typeof value === "string" &&
    value.length <= RELEASE_VERSION_LIMIT &&
    VERSION_PATTERN.test(value)
  );
}

export function isValidReleaseSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function expectedReleaseFilename(version, arch = RELEASE_ARCH) {
  if (!isValidReleaseVersion(version)) throw new Error("版本号无效");
  if (arch !== RELEASE_ARCH) throw new Error("不支持的处理器架构");
  return `Lizi-Setup-${version}-${arch}.exe`;
}

// Rebuilds the manifest with exactly the canonical fields in their fixed order.
// Rejects missing, extra or malformed fields so a signature can never cover a
// manifest that differs from what is displayed or stored.
export function validateReleaseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("发布清单必须为对象");
  const keys = Object.keys(value);
  if (
    keys.length !== RELEASE_MANIFEST_FIELDS.length ||
    keys.some((key) => !RELEASE_MANIFEST_FIELDS.includes(key))
  )
    throw new Error("发布清单字段不完整或包含多余字段");
  const { version, platform, arch, filename, size, sha256, publishedAt, notes } =
    value;
  if (!isValidReleaseVersion(version))
    throw new Error("版本号必须为 1.2.3 形式");
  if (platform !== RELEASE_PLATFORM || arch !== RELEASE_ARCH)
    throw new Error("发布清单仅支持 Windows x64");
  if (typeof filename !== "string" || filename !== expectedReleaseFilename(version, arch))
    throw new Error("安装包文件名与版本或架构不匹配");
  if (!Number.isSafeInteger(size) || size <= 0 || size > RELEASE_MAX_ARTIFACT_BYTES)
    throw new Error("安装包大小超出允许范围");
  if (!isValidReleaseSha256(sha256)) throw new Error("SHA256 摘要无效");
  if (
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt)) ||
    new Date(publishedAt).toISOString() !== publishedAt
  )
    throw new Error("发布时间必须为 ISO 8601 时间");
  if (typeof notes !== "string" || notes.length > RELEASE_NOTES_LIMIT)
    throw new Error(`更新说明不能超过 ${RELEASE_NOTES_LIMIT} 个字符`);
  return { version, platform, arch, filename, size, sha256, publishedAt, notes };
}

export function canonicalManifestBytes(manifest) {
  const canonical = validateReleaseManifest(manifest);
  return Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        RELEASE_MANIFEST_FIELDS.map((field) => [field, canonical[field]]),
      ),
    ),
    "utf8",
  );
}

export function isValidReleaseSignature(value) {
  return typeof value === "string" && SIGNATURE_PATTERN.test(value);
}

export function verifyManifestSignature(
  manifest,
  signature,
  publicKeyPem = RELEASE_PUBLIC_KEY_PEM,
) {
  if (!isValidReleaseSignature(signature)) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verifySignature(
      null,
      canonicalManifestBytes(manifest),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function parseReleaseVersion(value) {
  if (!isValidReleaseVersion(value)) throw new Error("版本号无效");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

// Standard semver ordering: numeric fields first, then a release outranks any
// prerelease, and prerelease identifiers compare numerically where numeric.
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric)
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isNewerReleaseVersion(candidate, current) {
  return compareReleaseVersions(candidate, current) > 0;
}
