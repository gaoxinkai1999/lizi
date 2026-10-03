import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { httpError } from "./directories.js";
import { transaction } from "./database.js";

const derive = promisify(scrypt);
const SESSION_AGE = 12 * 60 * 60 * 1000;
const COOKIE = "lizi_session";
const PUBLIC_USER = Object.freeze({
  id: "public",
  username: "公开访问",
  role: "admin",
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  role: user.role,
});

let activeDerivations = 0;
async function derivePassword(password, salt) {
  if (activeDerivations >= 4) throw httpError(429, "密码验证繁忙，请稍后再试");
  activeDerivations += 1;
  try {
    return await derive(password, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
  } finally {
    activeDerivations -= 1;
  }
}

export function validateUsername(username) {
  if (
    typeof username !== "string" ||
    username !== username.trim() ||
    username.length < 3 ||
    username.length > 40 ||
    /[\x00-\x1f\x7f]/.test(username)
  ) {
    throw httpError(400, "用户名需为 3–40 个字符，不能有首尾空格或控制字符");
  }
  return username;
}

export function validatePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    throw httpError(400, "密码需为 12–256 个字符");
  return password;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  const key = await derivePassword(password, salt);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [, salt, expected] = stored.split(":");
  const key = await derivePassword(password, salt);
  const bytes = Buffer.from(expected, "hex");
  return key.length === bytes.length && timingSafeEqual(key, bytes);
}

export function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Lizi-Request") !== "1")
    return next(httpError(403, "缺少安全请求标记"));
  const origin = req.get("Origin");
  const expected = `${req.protocol}://${req.get("host")}`;
  if (
    !origin ||
    origin !== expected ||
    ["cross-site", "none"].includes(req.get("Sec-Fetch-Site"))
  )
    return next(httpError(403, "拒绝非同源请求"));
  if (!req.is("application/json"))
    return next(httpError(415, "请求必须为 JSON"));
  return next();
}

export async function createAuth(
  db,
  home,
  isServer,
  configuredToken,
  onRevoke = () => {},
) {
  const initialized = () =>
    Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
  if (!isServer) return { initialized, identity, guard, admin };
  const tokenPath = path.join(home, "setup-token.txt");
  let setupToken = "";
  if (!initialized()) {
    if (configuredToken) {
      if (configuredToken.length < 32)
        throw new Error("LIZI_SETUP_TOKEN 至少需要32个字符");
      setupToken = configuredToken;
    } else {
      try {
        setupToken = (await fs.readFile(tokenPath, "utf8")).trim();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        setupToken = randomBytes(32).toString("base64url");
        await fs.writeFile(tokenPath, `${setupToken}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      }
      if (setupToken.length < 32)
        throw new Error("setup-token.txt 长度不足32个字符");
    }
  }
  const dummyPassword = await hashPassword(randomBytes(32).toString("hex"));
  db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
  function cookieOptions(req) {
    return {
      httpOnly: true,
      secure: req.secure,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_AGE,
    };
  }
  function session(req) {
    const value = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return (
      db
        .prepare(
          `SELECT users.*, sessions.hash AS sessionHash FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.hash=? AND sessions.expires>? AND users.disabled=0`,
        )
        .get(hash(value), Date.now()) ?? null
    );
  }
  function identity(req) {
    return isServer ? session(req) : PUBLIC_USER;
  }
  function issue(req, res, user) {
    const value = randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    const old = session(req);
    if (old)
      db.prepare("DELETE FROM sessions WHERE hash=?").run(old.sessionHash);
    db.prepare("INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)").run(
      hash(value),
      user.id,
      Date.now() + SESSION_AGE,
    );
    res.cookie(COOKIE, value, cookieOptions(req));
  }
  function revoke(userId) {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    onRevoke(userId);
  }
  function guard(req, res, next) {
    req.user = identity(req);
    return req.user ? next() : next(httpError(401, "请先登录，或会话已过期"));
  }
  function admin(req, res, next) {
    return req.user?.role === "admin"
      ? next()
      : next(httpError(403, "仅管理员可执行此操作"));
  }
  function throttle(req, label) {
    const now = Date.now();
    db.prepare("DELETE FROM login_attempts WHERE expires<=?").run(now);
    const keys = [`ip:${req.ip}`, `account:${hash(label.toLowerCase())}`];
    for (const key of keys) {
      const row = db
        .prepare("SELECT count,expires FROM login_attempts WHERE key=?")
        .get(key);
      const maximum = key.startsWith("ip:") ? 40 : 10;
      if (row && row.count >= maximum)
        throw httpError(429, "尝试次数过多，请15分钟后再试");
    }
    for (const key of keys)
      db.prepare(
        `INSERT INTO login_attempts(key,count,expires) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1`,
      ).run(key, now + 15 * 60 * 1000);
  }
  async function setup(req, res) {
    if (initialized()) throw httpError(409, "系统已经初始化");
    throttle(req, "setup");
    const { token, username, password } = req.body;
    if (
      typeof token !== "string" ||
      !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(setupToken)))
    )
      throw httpError(403, "初始化令牌无效");
    validateUsername(username);
    const encoded = await hashPassword(password);
    const user = { id: randomUUID(), username, role: "admin" };
    transaction(db, () => {
      if (initialized()) throw httpError(409, "系统已经初始化");
      db.prepare(
        "INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)",
      ).run(user.id, username, encoded, user.role);
    });
    setupToken = "";
    await fs
      .rm(tokenPath, { force: true })
      .catch((error) => console.error("无法清理初始化令牌文件:", error.code));
    issue(req, res, user);
    res.status(201).json({ user });
  }
  async function login(req, res) {
    const { username, password } = req.body;
    if (typeof username !== "string" || username.length > 40)
      throw httpError(400, "用户名无效");
    throttle(req, username);
    const user = db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(username);
    const valid = await verifyPassword(
      password,
      user?.password ?? dummyPassword,
    );
    if (!user || user.disabled || !valid)
      throw httpError(401, "用户名或密码错误");
    // A concurrent password reset or disable must defeat an in-flight login.
    const current = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    if (!current || current.disabled || current.password !== user.password)
      throw httpError(401, "账户已变更，请重新登录");
    db.prepare("DELETE FROM login_attempts WHERE key=?").run(
      `account:${hash(username.toLowerCase())}`,
    );
    issue(req, res, current);
    res.json({ user: publicUser(current) });
  }
  function logout(req, res) {
    if (req.user) {
      db.prepare("DELETE FROM sessions WHERE hash=?").run(req.user.sessionHash);
      onRevoke(req.user.id);
    }
    res.clearCookie(COOKIE, { ...cookieOptions(req), maxAge: undefined });
    res.json({ ok: true });
  }
  async function changePassword(req, res) {
    throttle(req, `password:${req.user.id}`);
    if (!(await verifyPassword(req.body.currentPassword, req.user.password)))
      throw httpError(403, "当前密码错误");
    const encoded = await hashPassword(req.body.password);
    transaction(db, () => {
      const current = session(req);
      if (!current || current.password !== req.user.password)
        throw httpError(401, "账户已变更，请重新登录");
      db.prepare("UPDATE users SET password=? WHERE id=?").run(
        encoded,
        req.user.id,
      );
      revoke(req.user.id);
    });
    issue(req, res, req.user);
    res.json({ ok: true });
  }
  function listUsers(req, res) {
    const users = db
      .prepare(
        "SELECT id,username,role,disabled FROM users ORDER BY username COLLATE NOCASE",
      )
      .all();
    res.json({
      users: users.map((user) => ({
        ...user,
        disabled: Boolean(user.disabled),
      })),
    });
  }
  async function addUser(req, res) {
    const username = validateUsername(req.body.username);
    const role = req.body.role;
    if (!["admin", "viewer"].includes(role)) throw httpError(400, "角色无效");
    const encoded = await hashPassword(req.body.password);
    if (session(req)?.role !== "admin")
      throw httpError(403, "管理员权限已失效");
    if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username))
      throw httpError(409, "用户名已存在");
    const user = { id: randomUUID(), username, role, disabled: false };
    db.prepare(
      "INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)",
    ).run(user.id, username, encoded, role);
    res.status(201).json({ user });
  }
  async function updateUser(req, res) {
    const { role, disabled, password } = req.body;
    if (role !== undefined && !["admin", "viewer"].includes(role))
      throw httpError(400, "角色无效");
    if (disabled !== undefined && typeof disabled !== "boolean")
      throw httpError(400, "禁用状态无效");
    if (role === undefined && disabled === undefined && password === undefined)
      throw httpError(400, "没有可更新的字段");
    const encoded =
      password === undefined ? undefined : await hashPassword(password);
    const result = transaction(db, () => {
      if (session(req)?.role !== "admin")
        throw httpError(403, "管理员权限已失效");
      const target = db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(req.params.id);
      if (!target) throw httpError(404, "账户不存在");
      const next = {
        ...target,
        role: role ?? target.role,
        disabled: disabled === undefined ? target.disabled : Number(disabled),
      };
      if (
        target.role === "admin" &&
        !target.disabled &&
        (next.role !== "admin" || next.disabled)
      ) {
        const admins = db
          .prepare(
            "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0",
          )
          .get().n;
        if (admins <= 1) throw httpError(409, "不能禁用或降级最后一位管理员");
      }
      db.prepare(
        "UPDATE users SET role=?,disabled=?,password=? WHERE id=?",
      ).run(next.role, next.disabled, encoded ?? target.password, target.id);
      revoke(target.id);
      return { ...publicUser(next), disabled: Boolean(next.disabled) };
    });
    res.json({ user: result });
  }
  return {
    initialized,
    identity,
    guard,
    admin,
    setup,
    login,
    logout,
    changePassword,
    listUsers,
    addUser,
    updateUser,
  };
}
