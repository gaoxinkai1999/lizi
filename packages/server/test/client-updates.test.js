import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signData,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalManifestBytes,
  expectedReleaseFilename,
  validateReleaseManifest,
} from "../../core/src/release-verification.js";
import {
  createUpdateManager,
  installerOutcome,
} from "../../../apps/desktop/src/client-updates.js";

const CENTER = "https://reports.abocidee.com";

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

function fakeResponse({ url, status = 200, json, body, contentLength }) {
  const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() !== "content-length") return null;
        const value = contentLength ?? payload?.length;
        return value === undefined ? null : String(value);
      },
    },
    body: body ?? (payload ? new Response(payload).body : undefined),
  };
}

async function manager(t, { currentVersion, publicKey, fetchImpl }) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-updates-"));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const instance = await createUpdateManager({
    app: { isPackaged: false, getPath: () => userData },
    currentVersion,
    publicKey,
    fetchImpl,
  });
  return { instance, userData };
}

function signedRelease(manifest, privateKey) {
  return {
    manifest,
    signature: signData(null, canonicalManifestBytes(manifest), privateKey).toString(
      "base64",
    ),
  };
}

test("client checks, verifies and downloads the signed artifact over the fixed center", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = randomBytes(8192);
  const manifest = buildManifest("3.1.0", payload, "断连自动恢复");
  const release = signedRelease(manifest, keys.privateKey);
  const { instance, userData } = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).origin, CENTER);
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release } });
      if (url.includes("/download"))
        return fakeResponse({
          url,
          body: new Response(payload).body,
          contentLength: payload.length,
        });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(instance.center, CENTER);
  const checked = await instance.check();
  assert.equal(checked.state, "available");
  assert.equal(checked.latest.version, "3.1.0");
  const ready = await instance.download();
  assert.equal(ready.state, "ready");
  assert.equal(ready.ready, true);
  assert.equal(ready.downloaded.sha256, manifest.sha256);
  const staged = path.join(userData, "updates", manifest.filename);
  assert.deepEqual(await fs.readFile(staged), payload);
});

test("client rejects bad signatures, off-center responses, downgrades and equal versions", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const foreign = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = randomBytes(2048);
  const manifest = buildManifest("3.1.0", payload);

  const foreignInstance = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) =>
      fakeResponse({ url, json: { release: signedRelease(manifest, foreign.privateKey) } }),
  });
  assert.equal((await foreignInstance.instance.check()).state, "error");
  assert.match(foreignInstance.instance.getStatus().error, /签名/);

  const offCenter = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async () =>
      fakeResponse({
        url: "https://evil.example/api/releases/latest",
        json: { release: signedRelease(manifest, keys.privateKey) },
      }),
  });
  assert.equal((await offCenter.instance.check()).state, "error");
  assert.match(offCenter.instance.getStatus().error, /来源异常/);

  const equal = await manager(t, {
    currentVersion: "3.1.0",
    publicKey,
    fetchImpl: async (url) =>
      fakeResponse({ url, json: { release: signedRelease(manifest, keys.privateKey) } }),
  });
  assert.equal((await equal.instance.check()).state, "up-to-date");
  assert.equal(equal.instance.getStatus().latest, null);
  assert.equal((await equal.instance.download()).state, "error");

  const empty = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => fakeResponse({ url, json: { release: null } }),
  });
  assert.equal((await empty.instance.check()).state, "up-to-date");
});

test("client rejects wrong hash or size and leaves no partial download behind", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = randomBytes(4096);
  const manifest = buildManifest("3.1.0", payload);
  const release = signedRelease(manifest, keys.privateKey);
  const { instance, userData } = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => {
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release } });
      return fakeResponse({
        url,
        body: new Response(randomBytes(4096)).body,
        contentLength: payload.length,
      });
    },
  });
  await instance.check();
  const failed = await instance.download();
  assert.equal(failed.state, "error");
  assert.match(failed.error, /SHA256/);
  assert.equal(failed.ready, false);
  const entries = await fs.readdir(path.join(userData, "updates"));
  assert.deepEqual(entries.filter((entry) => entry.endsWith(".part")), []);
});

test("client re-verifies the staged artifact and refuses to elevate a tampered file", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = randomBytes(4096);
  const manifest = buildManifest("3.1.0", payload);
  const release = signedRelease(manifest, keys.privateKey);
  const { instance, userData } = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => {
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release } });
      return fakeResponse({
        url,
        body: new Response(payload).body,
        contentLength: payload.length,
      });
    },
  });
  assert.match((await instance.install()).error, /请先下载更新/);
  await instance.check();
  await instance.download();
  const staged = path.join(userData, "updates", manifest.filename);
  await fs.writeFile(staged, randomBytes(payload.length));
  const tampered = await instance.install();
  assert.equal(tampered.state, "error");
  assert.match(tampered.error, /校验失败/);
  assert.equal(tampered.ready, false);
});

test("client rejects an oversized latest response", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const { instance } = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) =>
      fakeResponse({ url, json: { release: null, padding: "x".repeat(70000) } }),
  });
  const result = await instance.check();
  assert.equal(result.state, "error");
  assert.match(result.error, /过大/);
});

test("client downloads from the pinned mirror host and falls back to the center", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = randomBytes(8192);
  const manifest = buildManifest("3.1.0", payload);
  const mirror = "https://lizi-release-1317280880.cos.ap-beijing.myqcloud.com/releases/Lizi-Setup-3.1.0-x64.exe";

  // Happy path: latest advertises the mirror and the download never touches the
  // center uplink.
  const hits = [];
  const mirrored = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => {
      hits.push(url);
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release: { ...signedRelease(manifest, keys.privateKey), url: mirror } } });
      if (url === mirror)
        return fakeResponse({ url, body: new Response(payload).body, contentLength: payload.length });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal((await mirrored.instance.check()).latest.artifactUrl, mirror);
  const ready = await mirrored.instance.download();
  assert.equal(ready.state, "ready");
  assert.deepEqual(await fs.readFile(path.join(mirrored.userData, "updates", manifest.filename)), payload);
  assert.deepEqual(hits.filter((url) => url.startsWith(CENTER)), [`${CENTER}/api/releases/latest?platform=win32&arch=x64`]);

  // An unpinned mirror host is ignored and the center serves the bytes.
  const untrusted = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url) => {
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release: { ...signedRelease(manifest, keys.privateKey), url: "https://evil.example/Lizi-Setup-3.1.0-x64.exe" } } });
      return fakeResponse({ url, body: new Response(payload).body, contentLength: payload.length });
    },
  });
  assert.equal((await untrusted.instance.check()).latest.artifactUrl, null);
  assert.equal((await untrusted.instance.download()).state, "ready");

  // Mirror dies mid-download: the remainder is fetched from the center with a
  // Range request and the concatenation still matches the signed hash.
  const cut = 3000;
  const resumed = await manager(t, {
    currentVersion: "3.0.0",
    publicKey,
    fetchImpl: async (url, options) => {
      if (url.includes("/api/releases/latest"))
        return fakeResponse({ url, json: { release: { ...signedRelease(manifest, keys.privateKey), url: mirror } } });
      if (url === mirror) {
        const truncated = new Response(payload.subarray(0, cut)).body;
        return { ...fakeResponse({ url, body: truncated, contentLength: cut }), ok: true, status: 500 };
      }
      assert.equal(options.headers.range, `bytes=${cut}-`);
      return {
        ...fakeResponse({ url, body: new Response(payload.subarray(cut)).body, contentLength: payload.length - cut }),
        status: 206,
      };
    },
  });
  await resumed.instance.check();
  const finished = await resumed.instance.download();
  assert.equal(finished.state, "ready", finished.error);
  assert.deepEqual(await fs.readFile(path.join(resumed.userData, "updates", manifest.filename)), payload);
});

test("installer exit codes map to launch, UAC cancel and verification failures", () => {
  assert.deepEqual(installerOutcome(0), { ok: true });
  assert.deepEqual(installerOutcome(1223), { cancelled: true });
  assert.match(installerOutcome(11).error, /校验失败/);
  assert.match(installerOutcome(12).error, /校验失败/);
  assert.equal(installerOutcome(1).ok, false);
  assert.equal(installerOutcome(undefined).ok, true);
});
