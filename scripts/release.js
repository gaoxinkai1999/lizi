import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, setVersion } from "./version.js";
import { createCosClient, describeCosError } from "./cos-storage.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = { publish: false, deploy: false };
for (let index = 2; index < process.argv.length; index++) {
  const option = process.argv[index];
  if (option === "--publish" || option === "--deploy") options[option.slice(2)] = true;
  else if (["--version", "--notes", "--key"].includes(option)) {
    const value = process.argv[++index];
    if (!value) throw new Error(`${option} 缺少取值`);
    options[option.slice(2)] = value;
  } else throw new Error(`未知参数：${option}`);
}
if (!options.notes) throw new Error("请通过 --notes 提供更新说明");
const key = options.key || process.env.LIZI_RELEASE_KEY;
if (!key) throw new Error("请设置 LIZI_RELEASE_KEY 或传入 --key");
await fs.access(key);
if (options.publish) {
  for (const name of ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "LIZI_CENTER_USER", "LIZI_CENTER_PASSWORD"])
    if (!process.env[name]) throw new Error(`缺少 ${name}`);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error("请通过 npm run release 调用");
const env = { ...process.env };
if (process.platform === "win32")
  env.PSModulePath = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules");

async function run(command, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root, env, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
    if (input !== undefined) child.stdin.end(input);
  });
}

const version = options.version ? await setVersion(options.version) : await checkVersions();
if (options.publish) {
  const cos = createCosClient({ bucket: "lizi-release-1317280880" });
  const existing = await cos.headObject(`releases/Lizi-Setup-${version}-x64.exe`);
  if (existing.status === 200) throw new Error("该版本的安装包已经存在，请使用新的版本号");
  if (existing.status !== 404) throw new Error(`无法确认发布版本是否可用：${describeCosError(existing)}`);
}
await run(process.execPath, [npm, "test"]);
await run(process.execPath, [npm, "run", "dist"]);
await run(process.execPath, ["scripts/package-server.js"]);
const file = `release/Lizi-Setup-${version}-x64.exe`;
await run(process.execPath, ["scripts/sign-release.js", "--file", file, "--key", key, "--notes", options.notes]);
if (options.deploy) {
  const archive = `Lizi-Server-${version}.tar.gz`;
  await run("scp", [`release/${archive}`, `workspace-cn-new:/tmp/${archive}`]);
  await run(
    "ssh", ["workspace-cn-new", "sudo", "bash", "-s", "--", version],
    await fs.readFile(path.join(root, "deploy/release-center.sh"), "utf8"),
  );
}
if (options.publish)
  await run(process.execPath, ["scripts/publish-release.js", "--file", file, "--skip-sign", "1", "--notes", options.notes]);
console.log(`发版产物已验证：${version}。完成相关提交后立即 git push。`);
