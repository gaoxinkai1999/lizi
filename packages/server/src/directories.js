import fs from "node:fs/promises";
import path from "node:path";

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function createDirectoryPolicy(home, configuredRoots) {
  let roots;
  if (configuredRoots) {
    try {
      roots = JSON.parse(configuredRoots);
    } catch {
      throw new Error("LIZI_ALLOWED_ROOTS 必须是 JSON 路径数组");
    }
    if (
      !Array.isArray(roots) ||
      !roots.length ||
      roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))
    ) {
      throw new Error("LIZI_ALLOWED_ROOTS 必须是非空的绝对路径数组");
    }
  } else {
    roots = [path.join(home, "reports")];
    await fs.mkdir(roots[0], { recursive: true });
  }
  // Pin canonical roots so a replaced root symlink cannot broaden access later.
  const resolvedRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  const allowedRoots = [...new Set(resolvedRoots)];
  async function resolveDirectory(input) {
    if (
      typeof input !== "string" ||
      !path.isAbsolute(input) ||
      input.includes("\0")
    )
      throw httpError(400, "请选择绝对目录路径");
    const lexical = path.resolve(input);
    if (!allowedRoots.some((root) => isWithin(root, lexical)))
      throw httpError(403, "目录不在主机允许范围内");
    let actual;
    try {
      actual = await fs.realpath(lexical);
    } catch {
      throw httpError(400, "目录不存在或服务账户无权访问");
    }
    if (
      !allowedRoots.some(
        (root) => isWithin(root, lexical) && isWithin(root, actual),
      )
    ) {
      throw httpError(403, "链接指向允许范围以外的目录");
    }
    if (!(await fs.stat(actual)).isDirectory())
      throw httpError(400, "路径不是目录");
    return actual;
  }
  async function browse(input) {
    if (!input)
      return {
        path: "",
        parent: null,
        roots: allowedRoots,
        directories: allowedRoots.map((root) => ({ name: root, path: root })),
      };
    const actual = await resolveDirectory(input);
    const directories = [];
    for (const entry of await fs.readdir(actual, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(actual, entry.name);
      try {
        await resolveDirectory(child);
        directories.push({ name: entry.name, path: child });
      } catch {
        /* Do not disclose inaccessible or escaping links. */
      }
    }
    directories.sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
    let parent = path.dirname(actual);
    try {
      await resolveDirectory(parent);
    } catch {
      parent = null;
    }
    if (parent === actual) parent = null;
    return { path: actual, parent, roots: allowedRoots, directories };
  }
  return { allowedRoots, resolveDirectory, browse };
}
