import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signData,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { openDatabase } from "../src/database.js";
import { createAuth, hashPassword, requireSameOrigin } from "../src/auth.js";
import { httpError } from "../src/directories.js";
import { createReleases } from "../src/releases.js";
import {
  RELEASE_MIRROR_HOSTS,
  canonicalManifestBytes,
  compareReleaseVersions,
  expectedReleaseFilename,
  validateReleaseManifest,
  verifyManifestSignature,
} from "../../core/src/release-verification.js";

const ADMIN_PASSWORD = "admin-password-1";
const VIEWER_PASSWORD = "viewer-password-1";
const SETUP_TOKEN = "s".repeat(40);

function buildManifest(version, payload, notes = "") {
  return validateReleaseManifest({
    version,
    platform: "win32",
    arch: "x64",
    filename: expectedReleaseFilename(version),
    size: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    publishedAt: "2026-10-10T00:00:00.000Z",
    notes,
  });
}

async function fixture(t, options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-releases-"));
  const db = openDatabase(home);
  const auth = await createAuth(db, home, true, SETUP_TOKEN);
  const releases = await createReleases({
    home,
    auth,
    publicKey: options.publicKey ?? publicKeyPem,
    maxArtifactBytes: options.maxArtifactBytes,
    maxConcurrentUploads: options.maxConcurrentUploads,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", releases.publicRouter);
  app.use("/api", releases.uploadRouter);
  app.use("/api", requireSameOrigin);
  app.use(express.json({ limit: "1mb", strict: true }));
  app.post("/api/auth/setup", auth.setup);
  app.post("/api/auth/login", auth.login);
  app.use("/api", auth.guard);
  app.use("/api/releases", auth.admin, releases.adminRouter);
  app.use("/api", (req, res, next) => next(httpError(404, "接口不存在")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return res.destroy(error);
    const status = error.status ?? (error.type === "entity.too.large" ? 413 : 500);
    res.status(status >= 400 && status <= 599 ? status : 500).json({
      error: status === 500 ? "服务器处理失败" : error.message,
    });
  });
  const server = await new Promise((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await releases.close();
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  function cookieFrom(response) {
    const header = response.headers.getSetCookie().find((value) =>
      value.startsWith("lizi_session="),
    );
    assert.ok(header, "expected a session cookie");
    return header.split(";")[0];
  }

  async function call(target, { method = "GET", cookie, body, headers = {}, csrf = true, binary = false } = {}) {
    const finalHeaders = { ...headers };
    if (csrf && !["GET", "HEAD"].includes(method)) {
      finalHeaders["X-Lizi-Request"] = "1";
      finalHeaders.Origin = origin;
    }
    if (cookie) finalHeaders.Cookie = cookie;
    if (body !== undefined && !finalHeaders["Content-Type"])
      finalHeaders["Content-Type"] = "application/json";
    return fetch(`${origin}${target}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
  }

  const setup = await call("/api/auth/setup", {
    method: "POST",
    body: { token: SETUP_TOKEN, username: "admin", password: ADMIN_PASSWORD },
  });
  assert.equal(setup.status, 201);
  const adminCookie = cookieFrom(setup);
  db.prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)").run(
    randomUUID(),
    "viewer1",
    await hashPassword(VIEWER_PASSWORD),
    "viewer",
  );
  const login = await call("/api/auth/login", {
    method: "POST",
    body: { username: "viewer1", password: VIEWER_PASSWORD },
  });
  assert.equal(login.status, 200);
  const viewerCookie = cookieFrom(login);

  return {
    home,
    origin,
    db,
    releases,
    adminCookie,
    viewerCookie,
    publicKeyPem,
    sign(payload, version, notes) {
      const manifest = buildManifest(version, payload, notes);
      const signature = signData(
        null,
        canonicalManifestBytes(manifest),
        privateKey,
      ).toString("base64");
      return { manifest, signature };
    },
    upload(version, payload, cookie = adminCookie) {
      return call(`/api/releases/${version}/artifact`, {
        method: "PUT",
        cookie,
        binary: true,
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      });
    },
    publish(sidecar, cookie = adminCookie) {
      return call("/api/releases", { method: "POST", cookie, body: sidecar });
    },
    async put(payload, version, cookie = adminCookie) {
      const response = await this.upload(version, payload, cookie);
      assert.equal(response.status, 201, `upload ${version} rejected`);
      const published = await this.publish(this.sign(payload, version), cookie);
      assert.equal(published.status, 201, `publish ${version} rejected`);
      return published.json();
    },
  };
}

test("release writes require an admin session, CSRF token and binary uploads", async (t) => {
  const f = await fixture(t);
  const anonymous = await fetch(`${f.origin}/api/releases`);
  assert.equal(anonymous.status, 401);
  const viewer = await fetch(`${f.origin}/api/releases`, {
    headers: { Cookie: f.viewerCookie },
  });
  assert.equal(viewer.status, 403);
  const admin = await fetch(`${f.origin}/api/releases`, {
    headers: { Cookie: f.adminCookie },
  });
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), { releases: [], latest: null });

  const payload = randomBytes(2048);
  const noSession = await f.upload("3.1.0", payload, null);
  assert.equal(noSession.status, 403);
  const viewerUpload = await f.upload("3.1.0", payload, f.viewerCookie);
  assert.equal(viewerUpload.status, 403);
  const noCsrf = await fetch(`${f.origin}/api/releases/3.1.0/artifact`, {
    method: "PUT",
    headers: {
      Cookie: f.adminCookie,
      "Content-Type": "application/octet-stream",
    },
    body: payload,
  });
  assert.equal(noCsrf.status, 403);
  const wrongType = await fetch(`${f.origin}/api/releases/3.1.0/artifact`, {
    method: "PUT",
    headers: {
      Cookie: f.adminCookie,
      "X-Lizi-Request": "1",
      Origin: f.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(wrongType.status, 415);
  const publishNoCsrf = await fetch(`${f.origin}/api/releases`, {
    method: "POST",
    headers: { Cookie: f.adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: {}, signature: "" }),
  });
  assert.equal(publishNoCsrf.status, 403);

  const latest = await fetch(`${f.origin}/api/releases/latest?platform=win32&arch=x64`);
  assert.equal(latest.status, 200);
  assert.deepEqual(await latest.json(), { release: null });
});

test("upload streams and hashes exact bytes, rejecting duplicates and oversize", async (t) => {
  const f = await fixture(t, { maxArtifactBytes: 4096 });
  const payload = randomBytes(4096);
  const response = await f.upload("3.1.0", payload);
  assert.equal(response.status, 201);
  const staged = await response.json();
  assert.equal(staged.size, payload.length);
  assert.equal(staged.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.equal((await f.upload("3.1.0", payload)).status, 409);
  const staging = path.join(f.releases.releasesRoot, "staging");
  const retained = await fs.readdir(staging);

  const oversize = await f.upload("3.2.0", randomBytes(4097));
  assert.equal(oversize.status, 413);
  assert.deepEqual(await fs.readdir(staging), retained, "failed upload must preserve the earlier staged artifact");
  assert.deepEqual(await fs.readFile(path.join(staging, retained[0])), payload);
});

test("publication verifies the fixed signature and the exact staged artifact", async (t) => {
  const f = await fixture(t, { maxArtifactBytes: 4096 });
  const foreign = generateKeyPairSync("ed25519");
  const payload = randomBytes(2048);
  assert.equal((await f.upload("3.1.0", payload)).status, 201);

  const sidecar = f.sign(payload, "3.1.0");
  const foreignSignature = signData(
    null,
    canonicalManifestBytes(sidecar.manifest),
    foreign.privateKey,
  ).toString("base64");
  const badSignature = await f.publish({
    manifest: sidecar.manifest,
    signature: foreignSignature,
  });
  assert.equal(badSignature.status, 400);

  const other = f.sign(randomBytes(2048), "3.1.0");
  const mismatch = await f.publish(other);
  assert.equal(mismatch.status, 409);

  const unstaged = f.sign(randomBytes(2048), "3.0.2");
  assert.equal((await f.publish(unstaged)).status, 409);

  const invalid = await f.publish({ manifest: { version: "3.1.0" }, signature: "AA==" });
  assert.equal(invalid.status, 400);

  const published = await f.publish(sidecar);
  assert.equal(published.status, 201);
  const { release } = await published.json();
  assert.equal(release.version, "3.1.0");
  assert.equal(release.status, "published");
  assert.equal(release.sha256, sidecar.manifest.sha256);

  const artifact = path.join(f.releases.releasesRoot, "artifacts", "3.1.0", release.filename);
  assert.deepEqual(await fs.readFile(artifact), payload);
});

test("published versions are immutable and cannot be reused after withdrawal", async (t) => {
  const f = await fixture(t);
  const payload = randomBytes(1024);
  await f.put(payload, "3.1.0");
  assert.equal((await f.upload("3.1.0", payload)).status, 409);
  assert.equal((await f.publish(f.sign(payload, "3.1.0"))).status, 409);
  const withdrawn = await fetch(`${f.origin}/api/releases/3.1.0`, {
    method: "DELETE",
    headers: {
      Cookie: f.adminCookie,
      "X-Lizi-Request": "1",
      Origin: f.origin,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(withdrawn.status, 200);
  assert.equal((await withdrawn.json()).release.status, "withdrawn");
  assert.equal(
    (
      await fetch(`${f.origin}/api/releases/3.1.0`, {
        method: "DELETE",
        headers: {
          Cookie: f.adminCookie,
          "X-Lizi-Request": "1",
          Origin: f.origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    409,
  );
  assert.equal((await f.upload("3.1.0", payload)).status, 409);
});

test("withdrawing the latest release falls back to the previous stable version", async (t) => {
  const f = await fixture(t);
  const older = randomBytes(1024);
  const newest = randomBytes(2048);
  await f.put(older, "3.0.1");
  await f.put(newest, "3.1.0");

  const latest = await (await fetch(`${f.origin}/api/releases/latest`)).json();
  assert.equal(latest.release.manifest.version, "3.1.0");
  const download = await fetch(`${f.origin}/api/releases/3.1.0/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="Lizi-Setup-3.1.0-x64.exe"');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), newest);

  await fetch(`${f.origin}/api/releases/3.1.0`, {
    method: "DELETE",
    headers: {
      Cookie: f.adminCookie,
      "X-Lizi-Request": "1",
      Origin: f.origin,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const fallback = await (await fetch(`${f.origin}/api/releases/latest`)).json();
  assert.equal(fallback.release.manifest.version, "3.0.1");
  assert.equal((await fetch(`${f.origin}/api/releases/3.1.0/download`)).status, 404);
  const list = await (
    await fetch(`${f.origin}/api/releases`, { headers: { Cookie: f.adminCookie } })
  ).json();
  assert.equal(list.latest.version, "3.0.1");
  assert.equal(list.releases.find((entry) => entry.version === "3.1.0").status, "withdrawn");
  assert.deepEqual(
    list.releases.map((entry) => entry.version),
    ["3.1.0", "3.0.1"].sort(compareReleaseVersions).reverse(),
  );
});

test("mirrored releases publish, list and favour object storage over the center uplink", async (t) => {
  const f = await fixture(t);
  const payload = randomBytes(2048);
  const mirror = `https://${RELEASE_MIRROR_HOSTS[0]}/releases/Lizi-Setup-3.1.0-x64.exe`;
  assert.equal((await f.upload("3.1.0", payload)).status, 201);
  const published = await f.publish({ ...f.sign(payload, "3.1.0"), artifactUrl: mirror });
  assert.equal(published.status, 201);

  const latest = await (await fetch(`${f.origin}/api/releases/latest?platform=win32&arch=x64`)).json();
  assert.equal(latest.release.url, mirror);
  assert.equal(latest.release.manifest.version, "3.1.0");

  // The center keeps serving the bytes itself so clients that predate the
  // mirror support (redirect:"error") are not broken by a redirect.
  const streamedFromCenter = await fetch(`${f.origin}/api/releases/3.1.0/download`);
  assert.equal(streamedFromCenter.status, 200);
  assert.equal(streamedFromCenter.headers.get("location"), null);
  assert.deepEqual(Buffer.from(await streamedFromCenter.arrayBuffer()), payload);

  const list = await (
    await fetch(`${f.origin}/api/releases`, { headers: { Cookie: f.adminCookie } })
  ).json();
  assert.equal(list.latest.url, mirror);

  // A host outside the pinned mirror list is refused at publication time.
  const rejected = await f.publish({
    ...f.sign(randomBytes(16), "3.2.0"),
    artifactUrl: "https://evil.example/Lizi-Setup-3.2.0-x64.exe",
  });
  assert.equal(rejected.status, 400);

  // Releases without a mirror keep streaming from the center.
  const local = (await f.put(randomBytes(1024), "3.0.1")).release;
  assert.equal(local.url, "/api/releases/3.0.1/download");
  const streamed = await fetch(`${f.origin}/api/releases/3.0.1/download`);
  assert.equal(streamed.status, 200);
});

test("a mirrored release rejected after upload leaves nothing published", async (t) => {
  const f = await fixture(t);
  const payload = randomBytes(1024);
  assert.equal((await f.upload("3.1.0", payload)).status, 201);
  const rejected = await f.publish({
    ...f.sign(payload, "3.1.0"),
    artifactUrl: "https://evil.example/x.exe",
  });
  assert.equal(rejected.status, 400);
  const latest = await (await fetch(`${f.origin}/api/releases/latest`)).json();
  assert.equal(latest.release, null);
});

test("public latest is signed and survives a store restart while staged temp is dropped", async (t) => {
  const f = await fixture(t);
  const payload = randomBytes(1024);
  await f.put(payload, "3.1.0");
  const staged = randomBytes(1024);
  assert.equal((await f.upload("3.2.0", staged)).status, 201);

  const restart = await createReleases({
    home: f.home,
    auth: { identity: () => null },
    publicKey: f.publicKeyPem,
  });
  t.after(() => restart.close());
  const entry = restart.list().find((item) => item.version === "3.1.0");
  assert.equal(entry.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.deepEqual(await fs.readdir(path.join(f.home, "releases", "staging")), []);

  const latest = await (await fetch(`${f.origin}/api/releases/latest`)).json();
  assert.equal(latest.release.manifest.version, "3.1.0");
  assert.equal(
    verifyManifestSignature(
      latest.release.manifest,
      latest.release.signature,
      f.publicKeyPem,
    ),
    true,
  );

  await restart.close();
  const indexPath = path.join(f.home, "releases", "index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.releases["3.1.0"].manifest.notes = "tampered";
  await fs.writeFile(indexPath, JSON.stringify(index));
  await assert.rejects(() =>
    createReleases({
      home: f.home,
      auth: { identity: () => null },
      publicKey: f.publicKeyPem,
    }),
  );
});

test("concurrent staged uploads are bounded per configured limit", async (t) => {
  const f = await fixture(t, { maxConcurrentUploads: 1, maxArtifactBytes: 1024 * 1024 });
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const slow = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array(2048));
      await gate;
      controller.enqueue(new Uint8Array(2048));
      controller.close();
    },
  });
  const first = fetch(`${f.origin}/api/releases/3.1.0/artifact`, {
    method: "PUT",
    headers: {
      Cookie: f.adminCookie,
      "X-Lizi-Request": "1",
      Origin: f.origin,
      "Content-Type": "application/octet-stream",
    },
    body: slow,
    duplex: "half",
  });
  await delay(250);
  const second = await f.upload("3.2.0", randomBytes(2048));
  assert.equal(second.status, 503);
  releaseFirst();
  assert.equal((await first).status, 201);
});

test("concurrent publication is serialised and failed publishes stay invisible", async (t) => {
  const f = await fixture(t);
  const older = randomBytes(1024);
  const newer = randomBytes(2048);
  const broken = randomBytes(1024);
  for (const [version, payload] of [
    ["3.0.1", older],
    ["3.1.0", newer],
    ["3.2.0", broken],
  ])
    assert.equal((await f.upload(version, payload)).status, 201);

  const [first, second] = await Promise.all([
    f.publish(f.sign(older, "3.0.1")),
    f.publish(f.sign(newer, "3.1.0")),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const list = await (
    await fetch(`${f.origin}/api/releases`, { headers: { Cookie: f.adminCookie } })
  ).json();
  assert.deepEqual(
    list.releases.map((entry) => entry.version),
    ["3.1.0", "3.0.1"],
  );
  assert.equal(list.latest.version, "3.1.0");

  // A target file already on disk makes the exclusive copy fail; the version
  // must not appear in memory, in the list, or in the persisted index.
  const blocked = path.join(
    f.releases.releasesRoot,
    "artifacts",
    "3.2.0",
    "Lizi-Setup-3.2.0-x64.exe",
  );
  await fs.mkdir(path.dirname(blocked), { recursive: true });
  await fs.writeFile(blocked, "occupied");
  const failed = await f.publish(f.sign(broken, "3.2.0"));
  assert.equal(failed.status, 409);
  const after = await (
    await fetch(`${f.origin}/api/releases`, { headers: { Cookie: f.adminCookie } })
  ).json();
  assert.equal(after.releases.some((entry) => entry.version === "3.2.0"), false);
  const persisted = JSON.parse(
    await fs.readFile(path.join(f.home, "releases", "index.json"), "utf8"),
  );
  assert.equal("3.2.0" in persisted.releases, false);
  const publicLatest = await (await fetch(`${f.origin}/api/releases/latest`)).json();
  assert.equal(publicLatest.release.manifest.version, "3.1.0");
});
