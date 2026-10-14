import express from "express";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { once } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { httpError, isWithin } from "./directories.js";
import {
  RELEASE_ARCH,
  RELEASE_MAX_ARTIFACT_BYTES,
  RELEASE_PLATFORM,
  RELEASE_PUBLIC_KEY_PEM,
  compareReleaseVersions,
  isValidReleaseSignature,
  isValidReleaseVersion,
  validateReleaseArtifactUrl,
  validateReleaseManifest,
  verifyManifestSignature,
} from "../../core/src/release-verification.js";

export const MAX_ARTIFACT_BYTES = RELEASE_MAX_ARTIFACT_BYTES;
export const MAX_CONCURRENT_UPLOADS = 2;

class HashLimiter extends Transform {
  constructor(limit) {
    super();
    this.hash = createHash("sha256");
    this.size = 0;
    this.limit = limit;
  }
  _transform(chunk, _encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.limit) {
      callback(httpError(413, "安装包超过大小上限"));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
  digest() {
    return this.hash.digest("hex");
  }
}

function assertReleaseRecord(version, record, publicKey) {
  if (!record || typeof record !== "object")
    throw new Error(`发布索引中的 ${version} 损坏`);
  const manifest = validateReleaseManifest(record.manifest);
  if (manifest.version !== version)
    throw new Error(`发布索引中的 ${version} 与清单版本不一致`);
  if (!isValidReleaseSignature(record.signature))
    throw new Error(`发布索引中的 ${version} 缺少有效签名`);
  if (!verifyManifestSignature(manifest, record.signature, publicKey))
    throw new Error(`发布索引中的 ${version} 签名无法通过公钥校验`);
  if (!["published", "withdrawn"].includes(record.status))
    throw new Error(`发布索引中的 ${version} 状态无效`);
  if (typeof record.artifactPath !== "string" || path.isAbsolute(record.artifactPath))
    throw new Error(`发布索引中的 ${version} 安装包路径无效`);
  // artifactUrl is optional: older records have no mirror and are served from
  // the center itself.
  const artifactUrl =
    record.artifactUrl === undefined || record.artifactUrl === null
      ? null
      : validateReleaseArtifactUrl(record.artifactUrl);
  return {
    manifest,
    signature: record.signature,
    status: record.status,
    publishedAt: manifest.publishedAt,
    withdrawnAt:
      typeof record.withdrawnAt === "string" ? record.withdrawnAt : null,
    uploadedAt: typeof record.uploadedAt === "string" ? record.uploadedAt : null,
    artifactPath: record.artifactPath,
    artifactUrl,
  };
}

export async function createReleases(options) {
  const home = path.resolve(options.home);
  const auth = options.auth;
  if (!auth || typeof auth.identity !== "function")
    throw new Error("createReleases 需要提供中心认证接口");
  const publicKey = options.publicKey ?? RELEASE_PUBLIC_KEY_PEM;
  const maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  const maxConcurrentUploads = options.maxConcurrentUploads ?? MAX_CONCURRENT_UPLOADS;
  const releasesRoot = path.join(home, "releases");
  const stagingRoot = path.join(releasesRoot, "staging");
  const artifactsRoot = path.join(releasesRoot, "artifacts");
  const indexPath = path.join(releasesRoot, "index.json");

  const records = new Map();
  const staged = new Map();
  const activeUploads = new Set();

  await fs.mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
  // Interrupted uploads are never resumable state; a version is only trusted
  // once its metadata is published from a fully staged, hash-verified file.
  for (const entry of await fs.readdir(stagingRoot))
    await fs.rm(path.join(stagingRoot, entry), { recursive: true, force: true }).catch(() => {});
  try {
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    for (const [version, record] of Object.entries(index?.releases ?? {})) {
      if (!isValidReleaseVersion(version))
        throw new Error(`发布索引包含无效版本 ${version}`);
      records.set(version, assertReleaseRecord(version, record, publicKey));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  async function persist(target = records) {
    const payload = `${JSON.stringify(
      { version: 1, releases: Object.fromEntries(target) },
      null,
      2,
    )}\n`;
    const temporary = `${indexPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, indexPath);
  }

  // Publication changes are serialised so two concurrent mutations cannot
  // interleave their index writes or roll a freshly committed index back.
  let mutation = Promise.resolve();
  function serialize(task) {
    const running = mutation.then(task);
    mutation = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  function publicEntry(version, record) {
    return {
      ...record.manifest,
      status: record.status,
      withdrawnAt: record.withdrawnAt,
      url: record.artifactUrl ?? `/api/releases/${version}/download`,
    };
  }

  function sortedEntries() {
    return [...records.entries()]
      .sort((left, right) =>
        compareReleaseVersions(right[0], left[0]),
      )
      .map(([version, record]) => publicEntry(version, record));
  }

  function highestPublished(platform, arch) {
    return [...records.entries()]
      .filter(
        ([, record]) =>
          record.status === "published" &&
          (platform === undefined || record.manifest.platform === platform) &&
          (arch === undefined || record.manifest.arch === arch),
      )
      .sort((left, right) => compareReleaseVersions(right[0], left[0]))[0];
  }

  function requireUploadAdmin(req, res, next) {
    try {
      if (req.get("X-Lizi-Request") !== "1")
        throw httpError(403, "缺少安全请求标记");
      const origin = req.get("Origin");
      const expected = `${req.protocol}://${req.get("host")}`;
      if (!origin || origin !== expected)
        throw httpError(403, "拒绝非同源请求");
      if (["cross-site", "none"].includes(req.get("Sec-Fetch-Site")))
        throw httpError(403, "拒绝非同源请求");
      if (!req.is("application/octet-stream"))
        throw httpError(415, "安装包必须为二进制流");
      const user = auth.identity(req);
      if (!user || user.role !== "admin")
        throw httpError(403, "仅管理员可上传安装包");
      next();
    } catch (error) {
      next(error);
    }
  }

  // Mounted before the global JSON body parser and JSON-only same-origin gate:
  // application/octet-stream writes are authorised and streamed here instead.
  const uploadRouter = express.Router();
  uploadRouter.put("/releases/:version/artifact", requireUploadAdmin, async (req, res) => {
    const version = req.params.version;
    if (!isValidReleaseVersion(version)) throw httpError(400, "版本号无效");
    if (records.has(version))
      throw httpError(409, "该版本已发布或已撤回，版本号不可重用");
    if (staged.has(version)) throw httpError(409, "该版本安装包正在等待发布");
    if (activeUploads.has(version))
      throw httpError(409, "该版本安装包正在上传");
    if (activeUploads.size >= maxConcurrentUploads)
      throw httpError(503, "上传队列已满，请稍后重试");
    const declared = req.get("content-length");
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length <= 0 || length > maxArtifactBytes)
        throw httpError(413, "安装包大小超出允许范围");
    }
    activeUploads.add(version);
    req.setTimeout(30_000, () => req.destroy(new Error("安装包上传空闲超时")));
    const temporary = path.join(stagingRoot, `${version}.${randomUUID()}.part`);
    const sink = createWriteStream(temporary, { mode: 0o600, flags: "wx" });
    try {
      const limiter = new HashLimiter(maxArtifactBytes);
      await pipeline(req, limiter, sink);
      if (limiter.size === 0) throw httpError(400, "安装包内容为空");
      if (declared !== undefined && Number(declared) !== limiter.size)
        throw httpError(400, "安装包长度与请求声明不一致");
      const handle = await fs.open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const stagedRecord = {
        size: limiter.size,
        sha256: limiter.digest(),
        file: temporary,
      };
      staged.set(version, stagedRecord);
      res.status(201).json({
        version,
        size: stagedRecord.size,
        sha256: stagedRecord.sha256,
      });
    } catch (error) {
      // Wait for the file handle to close so the temp file can be removed on
      // Windows, then never leave partially received bytes behind.
      if (!sink.closed) await once(sink, "close").catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    } finally {
      activeUploads.delete(version);
    }
  });

  // Public read-only endpoints, reachable without a browser session exactly like
  // /api/health. Clients fetch these directly from the fixed center.
  const publicRouter = express.Router();
  publicRouter.get("/releases/latest", (req, res) => {
    const { platform, arch } = req.query;
    for (const [label, value, allowed] of [
      ["平台", platform, RELEASE_PLATFORM],
      ["架构", arch, RELEASE_ARCH],
    ]) {
      if (value !== undefined && value !== allowed)
        throw httpError(400, `${label}不受支持`);
    }
    const found = highestPublished(
      platform === undefined ? undefined : RELEASE_PLATFORM,
      arch === undefined ? undefined : RELEASE_ARCH,
    );
    res.json({
      release: found
        ? {
            manifest: found[1].manifest,
            signature: found[1].signature,
            // Where the client should download from. Object storage keeps the
            // center's metered uplink out of the update path entirely.
            url: found[1].artifactUrl ?? `/api/releases/${found[0]}/download`,
          }
        : null,
    });
  });
  publicRouter.get("/releases/:version/download", async (req, res) => {
    const version = req.params.version;
    const record = isValidReleaseVersion(version)
      ? records.get(version)
      : undefined;
    if (!record || record.status !== "published")
      throw httpError(404, "安装包不存在");
    // Deliberately not a redirect to the mirror: clients already deployed fetch
    // this endpoint with redirect:"error", so a 302 would break their updates.
    // They keep streaming from here at the center's uplink speed; clients built
    // from 3.1.3 on prefer the object-storage URL from /latest.
    const absolute = path.join(releasesRoot, record.artifactPath);
    if (!isWithin(releasesRoot, absolute))
      throw httpError(404, "安装包不存在");
    const stats = await fs.stat(absolute).catch(() => null);
    if (!stats?.isFile()) throw httpError(404, "安装包不存在");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${record.manifest.filename}"`,
    );
    await pipeline(createReadStream(absolute), res).catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: "安装包读取失败" });
      else res.destroy(error);
    });
  });

  // Admin JSON endpoints; the mount applies browser auth, admin role and the
  // global JSON same-origin gate before this router runs.
  const adminRouter = express.Router();
  adminRouter.get("/", (req, res) => {
    const releases = sortedEntries();
    res.json({
      releases,
      latest: releases.find((entry) => entry.status === "published") ?? null,
    });
  });
  adminRouter.post("/", async (req, res) => {
    const { manifest, signature, artifactUrl } = req.body ?? {};
    let canonical;
    let mirror = null;
    try {
      canonical = validateReleaseManifest(manifest);
      if (artifactUrl !== undefined && artifactUrl !== null)
        mirror = validateReleaseArtifactUrl(artifactUrl);
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (!isValidReleaseSignature(signature))
      throw httpError(400, "发布签名格式无效");
    if (!verifyManifestSignature(canonical, signature, publicKey))
      throw httpError(400, "发布签名未通过固定公钥校验");
    const version = canonical.version;
    const filename = canonical.filename;
    if (path.basename(filename) !== filename)
      throw httpError(400, "安装包文件名无效");
    const targetDirectory = path.join(artifactsRoot, version);
    const target = path.join(targetDirectory, filename);
    if (!isWithin(artifactsRoot, target)) throw httpError(400, "安装包路径无效");
    const record = await serialize(async () => {
      if (records.has(version))
        throw httpError(409, "该版本已发布或已撤回，版本号不可重用");
      const pending = staged.get(version);
      if (!pending) throw httpError(409, "请先上传该版本的安装包");
      if (pending.size !== canonical.size || pending.sha256 !== canonical.sha256)
        throw httpError(409, "安装包与发布清单的大小或 SHA256 不一致");
      await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      // COPYFILE_EXCL keeps a published version's bytes immutable: an existing
      // artifact is never overwritten.
      await fs.copyFile(pending.file, target, fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code === "EEXIST") throw httpError(409, "该版本安装包已存在");
        throw error;
      });
      const handle = await fs.open(target, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const created = {
        manifest: canonical,
        signature,
        status: "published",
        publishedAt: canonical.publishedAt,
        withdrawnAt: null,
        uploadedAt: new Date().toISOString(),
        artifactPath: path.relative(releasesRoot, target),
        artifactUrl: mirror,
      };
      const nextRecords = new Map(records);
      nextRecords.set(version, created);
      try {
        // Durable first: readers never observe a record that is not on disk.
        await persist(nextRecords);
      } catch (error) {
        await fs.rm(target, { force: true }).catch(() => {});
        throw error;
      }
      await fs.rm(pending.file, { force: true }).catch(() => {});
      records.set(version, created);
      staged.delete(version);
      return created;
    });
    res.status(201).json({ release: publicEntry(version, record) });
  });
  adminRouter.delete("/:version", async (req, res) => {
    const version = req.params.version;
    const record = await serialize(async () => {
      const current = isValidReleaseVersion(version)
        ? records.get(version)
        : undefined;
      if (!current) throw httpError(404, "版本不存在");
      if (current.status === "withdrawn") throw httpError(409, "该版本已撤回");
      const updated = {
        ...current,
        status: "withdrawn",
        withdrawnAt: new Date().toISOString(),
      };
      const nextRecords = new Map(records);
      nextRecords.set(version, updated);
      await persist(nextRecords);
      records.set(version, updated);
      return updated;
    });
    res.json({ release: publicEntry(version, record) });
  });

  return {
    releasesRoot,
    publicRouter,
    uploadRouter,
    adminRouter,
    list: () => sortedEntries(),
    async close() {
      activeUploads.clear();
      staged.clear();
    },
  };
}
