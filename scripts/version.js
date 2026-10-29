import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidReleaseVersion } from "../packages/core/src/release-verification.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/server/package.json",
];

async function json(file) {
  return JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
}

async function writeJson(file, value) {
  await fs.writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

export async function setVersion(version) {
  if (!isValidReleaseVersion(version)) throw new Error("版本号必须为 x.y.z");
  for (const file of manifests) {
    const manifest = await json(file);
    manifest.version = version;
    if (manifest.dependencies?.["@lizi/core"])
      manifest.dependencies["@lizi/core"] = version;
    await writeJson(file, manifest);
  }
  const lock = await json("package-lock.json");
  lock.version = version;
  for (const file of manifests) {
    const key = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    const entry = lock.packages[key];
    if (!entry) throw new Error(`锁文件缺少 ${key || "根包"}`);
    entry.version = version;
    if (entry.dependencies?.["@lizi/core"])
      entry.dependencies["@lizi/core"] = version;
  }
  await writeJson("package-lock.json", lock);
  for (const [file, pattern, replacement] of [
    ["packages/core/src/deployment.js", /APP_VERSION = "[^"]+"/, `APP_VERSION = "${version}"`],
    ["deploy/compose.yaml", /image: lizi-server:[^\s]+/, `image: lizi-server:${version}`],
    ["README.md", /Lizi-(?:Setup|Server)-\d+\.\d+\.\d+/g, (name) => name.replace(/\d+\.\d+\.\d+$/, version)],
    ["README.md", /acceptance-\d+\.\d+\.\d+\.json/g, `acceptance-${version}.json`],
  ]) {
    const location = path.join(root, file);
    await fs.writeFile(location, (await fs.readFile(location, "utf8")).replace(pattern, replacement));
  }
  return checkVersions();
}

export async function checkVersions() {
  const { version } = await json("package.json");
  const errors = [];
  const lock = await json("package-lock.json");
  for (const file of manifests) {
    const manifest = await json(file);
    if (manifest.version !== version) errors.push(`${file}: ${manifest.version}`);
    const key = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (lock.packages[key]?.version !== version) errors.push(`package-lock.json: ${key}`);
    if (manifest.dependencies?.["@lizi/core"] && manifest.dependencies["@lizi/core"] !== version)
      errors.push(`${file}: @lizi/core`);
    if (lock.packages[key]?.dependencies?.["@lizi/core"] &&
        lock.packages[key].dependencies["@lizi/core"] !== version)
      errors.push(`package-lock.json: ${key}/@lizi/core`);
  }
  if (lock.version !== version) errors.push("package-lock.json: 根版本");
  const deployment = await fs.readFile(path.join(root, "packages/core/src/deployment.js"), "utf8");
  const compose = (await fs.readFile(path.join(root, "deploy/compose.yaml"), "utf8")).replace(/\r\n/g, "\n");
  if (!deployment.includes(`APP_VERSION = "${version}"`)) errors.push("deployment.js");
  if (!compose.includes(`image: lizi-server:${version}\n`)) errors.push("compose.yaml");
  if (errors.length) throw new Error(`版本号不一致：\n${errors.join("\n")}`);
  console.log(`版本检查通过：${version}`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "set") await setVersion(process.argv[3]);
  else if (!process.argv[2] || process.argv[2] === "check") await checkVersions();
  else throw new Error("用法：node scripts/version.js check | set x.y.z");
}
