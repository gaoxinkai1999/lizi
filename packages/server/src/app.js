import express from "express";
import compression from "compression";
import helmet from "helmet";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isDate, todayString } from "@lizi/core";
import { openDatabase } from "./database.js";
import { createDirectoryPolicy, httpError } from "./directories.js";
import { createAuth, publicUser, requireSameOrigin } from "./auth.js";
import { ReportStore } from "./reports.js";
import { createLanManager } from "./lan.js";
import { FederatedReportStore } from "./federated-reports.js";
import { exportReports } from "./export.js";
import { createRemoteManager } from "../../../scripts/runtime/remote.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function ensureLocalAdminToken(home) {
  const file = path.join(home, "lan-admin-token.txt");
  try {
    const token = (await fs.readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await fs.writeFile(file, token, { encoding: "utf8", mode: 0o600, flag: "w" });
  return token;
}

export function parseReportQuery(input = {}) {
  const date = input.date ?? todayString();
  const shift = input.shift ?? "day";
  const exclude = input.excludeAggregate ?? false;
  if (!isDate(date)) throw httpError(400, "日期必须为有效的 YYYY-MM-DD");
  if (!["day", "night", "full"].includes(shift))
    throw httpError(400, "班次无效");
  if (![true, false, "true", "false"].includes(exclude))
    throw httpError(400, "总分析筛选参数无效");
  return {
    date,
    shift,
    excludeAggregate: exclude === true || exclude === "true",
  };
}

export async function createApplication(options = {}) {
  const home = path.resolve(
    options.home ?? process.env.LIZI_HOME ?? path.join(projectRoot, ".lizi"),
  );
  const port = Number(options.port ?? process.env.LIZI_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("LIZI_PORT 无效");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(home, 0o700);
  const localAdminToken = await ensureLocalAdminToken(home);
  const db = openDatabase(home);
  const directories = await createDirectoryPolicy(
    home,
    options.allowedRoots ?? process.env.LIZI_ALLOWED_ROOTS,
  );
  const remote = createRemoteManager({ home, port });
  const clients = new Set();
  const auth = await createAuth(
    db,
    home,
    options.setupToken ?? process.env.LIZI_SETUP_TOKEN,
    (userId) => {
      for (const client of clients)
        if (client.userId === userId) client.res.end();
    },
    (authenticationEnabled) => {
      for (const client of clients) {
        client.res.end(
          `event: access\ndata: ${JSON.stringify({ authenticationEnabled })}\n\n`,
        );
      }
      clients.clear();
    },
  );
  const localStore = new ReportStore(db, directories);
  let lan;
  try {
    lan = await createLanManager({
      home,
      store: localStore,
      options: options.lan ?? {},
    });
  } catch (error) {
    await localStore.close();
    await remote.stop();
    db.close();
    throw error;
  }
  const store = new FederatedReportStore(localStore, lan);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      strictTransportSecurity: false,
    }),
  );
  app.use(
    compression({
      filter: (req, res) =>
        req.path !== "/api/events" && compression.filter(req, res),
    }),
  );
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", requireSameOrigin);
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (!req.body || Array.isArray(req.body))
    )
      return next(httpError(400, "请求体必须为 JSON 对象"));
    next();
  });
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.get("/api/auth/state", (req, res) => {
    const user = auth.identity(req);
    res.json({
      initialized: auth.initialized(),
      authenticationEnabled: auth.authenticationEnabled(),
      user: user ? publicUser(user) : null,
      dataRoot: user ? store.root : null,
      dataScope: user ? lan.getSettings().epoch : null,
      transientReports: Boolean(
        user && lan.getSettings().mode === "host" && lan.getSettings().peer,
      ),
      today: todayString(),
    });
  });
  app.use(["/api/auth", "/api/users"], auth.accountsGuard);
  app.post("/api/auth/setup", auth.setup);
  app.post("/api/auth/login", auth.login);
  app.use("/api", auth.guard);
  app.put("/api/access", auth.admin, requireLocalAdmin, auth.setAccess);
  app.post("/api/auth/logout", auth.logout);
  app.post("/api/auth/password", auth.changePassword);
  function assertCurrentIdentity(req) {
    const current = auth.identity(req);
    if (
      !current ||
      current.id !== req.user.id ||
      current.role !== req.user.role
    )
      throw httpError(401, "访问权限已变化，请重新连接");
  }
  function reportClient(req, required = false) {
    const id = req.method === "GET" ? req.query.clientId : req.body.clientId;
    if (id === undefined && !required) return undefined;
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw httpError(400, "报告会话标识无效，请刷新页面");
    return `${req.user.id}:${id}`;
  }
  app.get("/api/reports", async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw httpError(400, "分页参数无效，每页最多100份报告");
    const result = await store.query({
      ...parseReportQuery(req.query),
      page,
      pageSize,
      clientId: reportClient(req),
    });
    assertCurrentIdentity(req);
    res.setHeader(
      "Cache-Control",
      result.transient ? "no-store" : "private, no-cache",
    );
    res.json(result);
  });
  app.post("/api/reports/lease", (req, res) => {
    const clientId = reportClient(req, true);
    if (req.body.release === true) store.release(clientId);
    else store.touch(parseReportQuery(req.body), clientId);
    res.json({ ok: true });
  });
  app.post("/api/reports/release", (req, res) => {
    store.release(reportClient(req, true));
    res.json({ ok: true });
  });
  app.post("/api/reports/export", async (req, res) => {
    const query = parseReportQuery(req.body);
    if (req.body.ids !== undefined) {
      if (
        !Array.isArray(req.body.ids) ||
        !req.body.ids.length ||
        req.body.ids.length > 20000 ||
        req.body.ids.some(
          (id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id),
        )
      ) {
        throw httpError(400, "请选择有效报告后导出");
      }
    }
    if (
      req.body.allSelected !== undefined &&
      typeof req.body.allSelected !== "boolean"
    )
      throw httpError(400, "全班次选择参数无效");
    if (req.body.allSelected && req.body.ids !== undefined)
      throw httpError(400, "不能同时指定全班次和报告ID");
    const snapshot = await store.exportSnapshot(query, {
      ids: req.body.ids,
      allSelected: req.body.allSelected === true,
    });
    try {
      assertCurrentIdentity(req);
      await exportReports(res, snapshot, query.date, query.shift);
    } finally {
      await snapshot.close();
    }
  });
  function publicLanStatus() {
    const { mode, name, connected, lastError } = lan.getStatus();
    return {
      mode,
      name,
      connected,
      lastError: lastError ? "局域网连接异常" : null,
      listening: false,
      peer: null,
      addresses: [],
      discovered: [],
      pairing: { openUntil: null, pending: [] },
      joining: null,
    };
  }
  function status() {
    return {
      version: "2.2.1",
      ...store.status(),
      service: {
        mode: process.env.LIZI_SERVICE === "1" ? "service" : "standalone",
        uptime: Math.floor(process.uptime()),
      },
      remote: remote.getStatus(),
      lan: publicLanStatus(),
      cacheEpoch: lan.getSettings().epoch,
    };
  }
  app.get("/api/status", (req, res) => res.json(status()));
  function settings() {
    return {
      dataPath: store.root,
      allowedRoots: directories.allowedRoots,
      authenticationEnabled: auth.authenticationEnabled(),
      remote: remote.getSettings(),
    };
  }
  app.get("/api/settings", auth.admin, (req, res) => res.json(settings()));
  app.put("/api/settings", auth.admin, requireLocalAdmin, async (req, res) => {
    await store.setRoot(req.body.dataPath);
    res.json(settings());
  });
  app.get("/api/directories", auth.admin, async (req, res) =>
    res.json(await directories.browse(req.query.path)),
  );
  app.post("/api/scan", auth.admin, requireLocalAdmin, async (req, res) => {
    if (!store.root) throw httpError(400, "请先配置报告目录");
    void store
      .scan()
      .catch((error) => console.error("日期目录扫描失败：", error));
    res.status(202).json({ ok: true, scanning: true });
  });
  app.put("/api/remote", auth.admin, requireLocalAdmin, async (req, res) => {
    await remote.configure(req.body);
    res.json(settings());
  });
  function localLanAdministration(req) {
    const address = req.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address))
      return false;
    if (
      Object.keys(req.headers).some(
        (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
      )
    )
      return false;
    try {
      const hostname = new URL(`http://${req.headers.host}`).hostname;
      return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
    } catch {
      return false;
    }
  }
  function localAdminAuthorized(req) {
    if (!localLanAdministration(req)) return false;
    const presented = req.get("X-Lizi-Local-Admin");
    if (!presented || !/^[A-Za-z0-9_-]{43}$/.test(presented)) return false;
    const expected = Buffer.from(localAdminToken);
    const actual = Buffer.from(presented);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  function requireLocalAdmin(req, res, next) {
    if (!localAdminAuthorized(req))
      return next(httpError(403, "仅本机桌面可以修改此配置"));
    next();
  }
  function lanStatus(req) {
    const canManage = localAdminAuthorized(req) && req.user?.role === "admin";
    return { ...(canManage ? lan.getStatus() : publicLanStatus()), canManage };
  }
  const localLanOnly = requireLocalAdmin;
  app.get("/api/lan", (req, res) => res.json(lanStatus(req)));
  app.put("/api/lan", auth.admin, localLanOnly, async (req, res) => {
    await lan.configure(req.body);
    res.json(lanStatus(req));
  });
  for (const [route, action] of [
    ["discover", "discover"],
    ["pairing", "openPairing"],
    ["join", "join"],
    ["approve", "approve"],
  ]) {
    app.post(
      `/api/lan/${route}`,
      auth.admin,
      localLanOnly,
      async (req, res) => {
        await lan[action](req.body);
        res.json(lanStatus(req));
      },
    );
  }
  app.delete("/api/lan/peer", auth.admin, localLanOnly, async (req, res) => {
    await lan.disconnect();
    res.json(lanStatus(req));
  });
  app.get("/api/users", auth.admin, auth.listUsers);
  app.post("/api/users", auth.admin, auth.addUser);
  app.patch("/api/users/:id", auth.admin, auth.updateUser);
  function sendEvent(client, event, data) {
    const user = auth.identity(client.req);
    if (!user || user.id !== client.userId) {
      client.res.end();
      return;
    }
    if (client.res.writableLength > 65536) {
      client.res.end();
      return;
    }
    client.res.write(
      event
        ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        : ": keepalive\n\n",
    );
  }
  app.get("/api/events", (req, res) => {
    const authenticationEnabled = auth.authenticationEnabled();
    const connections = authenticationEnabled
      ? [...clients].filter((client) => client.userId === req.user.id).length
      : clients.size;
    const limit = authenticationEnabled ? 8 : 128;
    if (connections >= limit)
      throw httpError(429, "实时连接过多，请关闭多余页面");
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const client = { req, res, userId: req.user.id };
    clients.add(client);
    sendEvent(client, "data", { revision: store.revision });
    sendEvent(client, "status", status());
    const timer = setInterval(() => sendEvent(client), 20000);
    timer.unref();
    res.on("close", () => {
      clearInterval(timer);
      clients.delete(client);
    });
  });
  store.on("revision", () => {
    for (const client of clients)
      sendEvent(client, "data", { revision: store.revision });
  });
  store.on("status", () => {
    const current = status();
    for (const client of clients) sendEvent(client, "status", current);
  });
  app.use("/api", (req, res, next) => next(httpError(404, "接口不存在")));
  const webDist = path.resolve(
    options.webDist ??
      process.env.LIZI_WEB_DIST ??
      path.join(projectRoot, "apps/web/dist"),
  );
  app.use(
    "/assets",
    express.static(path.join(webDist, "assets"), {
      dotfiles: "deny",
      immutable: true,
      maxAge: "1y",
      index: false,
    }),
  );
  app.use(
    express.static(webDist, {
      dotfiles: "deny",
      index: false,
      maxAge: 0,
      setHeaders(res, file) {
        if (path.basename(file) === "sw.js")
          res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  app.get("/{*path}", async (req, res, next) => {
    if (!req.accepts("html")) return next(httpError(404, "页面不存在"));
    res.sendFile(path.join(webDist, "index.html"), (error) => {
      if (error) next(httpError(503, "界面尚未构建，请先构建 Web 应用"));
    });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status =
      error.status ?? (error.type === "entity.too.large" ? 413 : 500);
    if (status >= 500) console.error(error);
    res.status(status >= 400 && status <= 599 ? status : 500).json({
      error:
        status === 500
          ? "服务器处理失败，请查看后台日志"
          : error.type === "entity.parse.failed"
            ? "JSON 格式无效"
            : error.message,
    });
  });
  const ready = store.start();
  return {
    app,
    home,
    port,
    db,
    store,
    lan,
    localStore,
    ready,
    async close() {
      for (const client of clients) client.res.end();
      await lan.close();
      await store.close();
      await remote.stop();
      db.close();
    },
  };
}
