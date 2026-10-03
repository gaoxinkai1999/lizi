import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const name = `Lizi-Server-${version}`;
const staging = join(release, name);
await readFile(join(root, "apps/web/dist/index.html"));
// This directory contains generated distribution files only.
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const entry of [
  "package.json", "package-lock.json", ".dockerignore",
  "packages/core/package.json", "packages/core/src",
  "packages/server/package.json", "packages/server/src",
  "apps/web/package.json", "apps/web/dist", "apps/desktop/package.json",
  "deploy/Dockerfile", "deploy/compose.yaml", "deploy/install-linux.sh",
  "scripts/start-server.js", "README.md",
]) {
  await mkdir(dirname(join(staging, entry)), { recursive: true });
  await cp(join(root, entry), join(staging, entry), { recursive: true });
}
const archive = `${name}.tar.gz`;
await new Promise((resolveDone, reject) => {
  const child = spawn("tar", ["-czf", archive, name], { cwd: release, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolveDone() : reject(new Error(`tar exited ${code}`)));
});
console.log(`Server distribution: ${join(release, archive)}`);
