import { cp, mkdir, rm, readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "apps/desktop/resources/backend");
const npmCli = process.argv[2];
if (!npmCli)
  throw new Error(
    "Run scripts/Prepare-Resources.ps1 to supply the pinned Node/npm runtime.",
  );
await access(join(root, "apps/web/dist/index.html"));
await access(join(root, "package-lock.json"));
// This directory is generated exclusively by this script; no user data lives here.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of ["package.json", "package-lock.json"])
  await cp(join(root, file), join(destination, file));
for (const directory of [
  "packages/server",
  "packages/core",
  "apps/web/dist",
]) {
  await cp(join(root, directory), join(destination, directory), {
    recursive: true,
    filter: (source) =>
      !source
        .split(/[\\/]/)
        .some((part) => part === "node_modules" || part === ".lizi"),
  });
}
// Keep the workspace graph from the real lockfile. Only backend workspaces are installed.
for (const workspace of ["apps/web", "apps/desktop"]) {
  await mkdir(join(destination, workspace), { recursive: true });
  await cp(
    join(root, workspace, "package.json"),
    join(destination, workspace, "package.json"),
  );
}
const server = JSON.parse(
  await readFile(join(destination, "packages/server/package.json"), "utf8"),
);
const core = JSON.parse(
  await readFile(join(destination, "packages/core/package.json"), "utf8"),
);
const command = spawn(
  process.execPath,
  [
    npmCli,
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    `--workspace=${server.name}`,
    `--workspace=${core.name}`,
    "--no-audit",
    "--no-fund",
  ],
  {
    cwd: destination,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  },
);
await new Promise((resolveDone, reject) => {
  command.once("error", reject);
  command.once("exit", (code) =>
    code === 0
      ? resolveDone()
      : reject(new Error(`Production dependency install failed (${code})`)),
  );
});
// npm creates Windows junctions to workspace sources. Installers must carry real
// directories, not links back into the build machine's temporary staging tree.
for (const [manifest, workspace] of [
  [core, "packages/core"],
  [server, "packages/server"],
]) {
  const modulePath = join(destination, "node_modules", manifest.name);
  await rm(modulePath, { recursive: true, force: true });
  await cp(join(destination, workspace), modulePath, {
    recursive: true,
    dereference: true,
  });
}
console.log(
  `Backend, locked production dependencies and web assets staged at ${destination}`,
);
