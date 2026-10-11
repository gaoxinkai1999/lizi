import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signData } from "node:crypto";
import {
  RELEASE_ARCH,
  RELEASE_MANIFEST_FIELDS,
  RELEASE_MAX_ARTIFACT_BYTES,
  RELEASE_PLATFORM,
  RELEASE_PUBLIC_KEY_PEM,
  canonicalManifestBytes,
  compareReleaseVersions,
  expectedReleaseFilename,
  isNewerReleaseVersion,
  validateReleaseManifest,
  verifyManifestSignature,
} from "../src/release-verification.js";

function bytes(size = 4096) {
  return Buffer.alloc(size, 7);
}

function manifestFor(version, payload = bytes()) {
  return validateReleaseManifest({
    version,
    platform: RELEASE_PLATFORM,
    arch: RELEASE_ARCH,
    filename: expectedReleaseFilename(version),
    size: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    publishedAt: "2026-10-10T00:00:00.000Z",
    notes: "修复离线采集与断连恢复",
  });
}

test("canonical manifest rejects missing, extra and malformed fields", () => {
  const manifest = manifestFor("3.1.0");
  assert.deepEqual(Object.keys(manifest), [...RELEASE_MANIFEST_FIELDS]);
  const canonical = canonicalManifestBytes(manifest).toString("utf8");
  assert.equal(
    canonical,
    JSON.stringify({
      version: "3.1.0",
      platform: "win32",
      arch: "x64",
      filename: "Lizi-Setup-3.1.0-x64.exe",
      size: manifest.size,
      sha256: manifest.sha256,
      publishedAt: "2026-10-10T00:00:00.000Z",
      notes: "修复离线采集与断连恢复",
    }),
  );
  assert.throws(() => validateReleaseManifest({ ...manifest, extra: 1 }));
  const { notes, ...missing } = manifest;
  assert.throws(() => validateReleaseManifest(missing));
  assert.throws(() => validateReleaseManifest({ ...manifest, version: "3.1" }));
  assert.throws(() => validateReleaseManifest({ ...manifest, architecture: notes }));
  assert.throws(() => validateReleaseManifest({ ...manifest, arch: "arm64" }));
  assert.throws(() =>
    validateReleaseManifest({ ...manifest, filename: "Lizi-Setup-3.0.0-x64.exe" }),
  );
  assert.throws(() => validateReleaseManifest({ ...manifest, size: 0 }));
  assert.throws(() =>
    validateReleaseManifest({ ...manifest, size: RELEASE_MAX_ARTIFACT_BYTES + 1 }),
  );
  assert.throws(() =>
    validateReleaseManifest({
      ...manifest,
      version: `3.1.0-${"a".repeat(40)}`,
    }),
  );
  assert.throws(() => validateReleaseManifest({ ...manifest, sha256: "Z".repeat(64) }));
  assert.throws(() =>
    validateReleaseManifest({ ...manifest, publishedAt: "2026-10-10" }),
  );
});

test("signatures verify against the signing key and fail against any other key", () => {
  const signing = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const signingPem = signing.publicKey.export({ type: "spki", format: "pem" });
  const otherPem = other.publicKey.export({ type: "spki", format: "pem" });
  const manifest = manifestFor("3.1.0");
  const signature = signData(
    null,
    canonicalManifestBytes(manifest),
    signing.privateKey,
  ).toString("base64");
  assert.equal(verifyManifestSignature(manifest, signature, signingPem), true);
  assert.equal(verifyManifestSignature(manifest, signature, otherPem), false);
  assert.equal(verifyManifestSignature(manifest, signature, RELEASE_PUBLIC_KEY_PEM), false);
  assert.equal(verifyManifestSignature(manifest, "not-base64", signingPem), false);
  assert.equal(
    verifyManifestSignature(manifest, `${"A".repeat(86)}==`, signingPem),
    false,
  );
  const tampered = { ...manifest, notes: "被篡改" };
  assert.equal(verifyManifestSignature(tampered, signature, signingPem), false);
  const wrongHash = { ...manifest, sha256: "0".repeat(64) };
  assert.equal(verifyManifestSignature(wrongHash, signature, signingPem), false);
});

test("release versions order numerically and prereleases rank below releases", () => {
  assert.equal(compareReleaseVersions("3.1.0", "3.1.0"), 0);
  assert.equal(compareReleaseVersions("3.1.0", "3.0.9"), 1);
  assert.equal(compareReleaseVersions("3.10.0", "3.9.0"), 1);
  assert.equal(compareReleaseVersions("3.2.0", "3.1.0"), 1);
  assert.equal(compareReleaseVersions("3.1.0-beta.2", "3.1.0"), -1);
  assert.equal(compareReleaseVersions("3.1.0-beta.10", "3.1.0-beta.2"), 1);
  assert.equal(isNewerReleaseVersion("3.1.0", "3.0.0"), true);
  assert.equal(isNewerReleaseVersion("3.0.0", "3.0.0"), false);
  assert.equal(isNewerReleaseVersion("3.0.0", "3.1.0"), false);
});
