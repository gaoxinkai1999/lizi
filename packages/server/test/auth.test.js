import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createApplication } from "../src/app.js";
import { openDatabase, setSetting } from "../src/database.js";

async function fixture(t, { mode = "client", prepare } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-auth-"));
  await prepare?.(home);
  const token = "a-secure-one-time-bootstrap-token-for-tests";
  let runtime;
  let server;
  let origin;
  async function start() {
    runtime = await createApplication({
      home,
      mode,
      setupToken: mode === "server" ? token : undefined,
      allowedRoots: JSON.stringify([home]),
    });
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    await runtime.ready;
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  }
  await start();
  const localAdminToken = mode === "client"
    ? (await fs.readFile(path.join(home, "lan-admin-token.txt"), "utf8")).trim()
    : null;
  t.after(async () => {
    await stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function request(
    route,
    { method = "GET", body, cookie, headers = {} } = {},
  ) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(`${origin}${route}`, {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Lizi-Request": "1",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      }, (incoming) => resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode,
        headers: incoming.headers,
      })));
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return {
    request,
    token,
    home,
    localAdminToken,
    async restart() {
      await stop();
      await start();
    },
  };
}

const password = "a-password-long-enough";

test("LAN configuration remains local-only even when the report site is public", async (t) => {
  const { request, localAdminToken } = await fixture(t);
  const local = await (await request("/api/lan")).json();
  assert.equal(local.canManage, false);
  assert.deepEqual(local.addresses, []);
  assert.deepEqual(local.discovered, []);
  assert.deepEqual(local.peers, []);
  const managed = await (
    await request("/api/lan", {
      headers: {
        "X-Lizi-Local-Admin": localAdminToken,
      },
    })
  ).json();
  assert.equal(managed.canManage, true);
  for (const headers of [
    { "X-Forwarded-For": "192.168.10.20" },
    { Forwarded: "for=192.168.10.20" },
    { Host: "reports.example", Origin: "http://reports.example" },
  ]) {
    const response = await request("/api/lan", {
      method: "PUT",
      body: { mode: "collector", name: "unauthorized" },
      headers: { "X-Lizi-Local-Admin": localAdminToken, ...headers },
    });
    assert.equal(response.status, 403);
    const status = await (await request("/api/lan", {
      headers: { "X-Lizi-Local-Admin": localAdminToken, ...headers },
    })).json();
    assert.equal(status.canManage, false);
    assert.equal(status.mode, "standalone");
  }
  for (const [route, method, body] of [
    ["/api/settings", "PUT", { dataPath: "" }],
    ["/api/scan", "POST", {}],
    ["/api/sync", "PUT", { enabled: true }],
    ["/api/sync/retry", "POST", {}],
    ["/api/sync/backfill", "POST", {}],
    ["/api/lan", "PUT", { mode: "collector" }],
  ]) {
    assert.equal((await request(route, { method, body })).status, 403, route);
  }
  assert.equal(
    (
      await request("/api/reports/lease", {
        method: "POST",
        body: { clientId: "invalid" },
      })
    ).status,
    400,
  );
});

test("bootstrap needs a token and same-origin marker; sessions enforce role and immediate disable", async (t) => {
  const { request, token } = await fixture(t, {
    mode: "server",
    prepare(home) {
      const db = openDatabase(home);
      setSetting(db, "authenticationEnabled", false);
      db.close();
    },
  });
  const state = await (await request("/api/auth/state")).json();
  assert.equal(state.authenticationEnabled, true);
  assert.equal(state.user, null);
  assert.equal((await request("/api/reports")).status, 401);
  assert.equal(
    (
      await request("/api/auth/setup", {
        method: "POST",
        body: { token, username: "admin", password },
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/setup", {
        method: "POST",
        body: { token: "wrong", username: "admin", password },
      })
    ).status,
    403,
  );
  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { token, username: "admin", password },
  });
  assert.equal(setup.status, 201);
  const admin = (await setup.json()).user;
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  assert.match(setup.headers.get("set-cookie"), /HttpOnly/);
  assert.match(setup.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(
    (
      await request(`/api/users/${admin.id}`, {
        method: "PATCH",
        cookie,
        body: { disabled: true },
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/api/users/${admin.id}`, {
      method: "PATCH", cookie, body: { role: "viewer" },
    })).status,
    409,
  );
  const added = await request("/api/users", {
    method: "POST",
    cookie,
    body: { username: "viewer", password, role: "viewer" },
  });
  assert.equal(added.status, 201);
  const viewer = (await added.json()).user;
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "viewer", password },
  });
  assert.equal(login.status, 200);
  const viewerCookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await request("/api/status", { cookie: viewerCookie })).status,
    200,
  );
  assert.equal(
    (await request("/api/settings", { cookie: viewerCookie })).status,
    403,
  );
  assert.equal((await request("/api/users", { cookie: viewerCookie })).status, 403);
  assert.equal((await request("/api/users", {
    method: "POST", cookie: viewerCookie,
    body: { username: "unauthorized", password, role: "admin" },
  })).status, 403);
  assert.equal(
    (
      await request("/api/auth/password", {
        method: "POST",
        cookie: viewerCookie,
        body: { currentPassword: password, password: "new-long-password" },
        headers: { "X-Lizi-Request": "" },
      })
    ).status,
    403,
  );
  const stream = await request("/api/events", { cookie: viewerCookie });
  assert.equal(stream.status, 200);
  const closed = stream.text();
  assert.equal(
    (
      await request(`/api/users/${viewer.id}`, {
        method: "PATCH",
        cookie,
        body: { disabled: true },
      })
    ).status,
    200,
  );
  await closed;
  assert.equal(
    (await request("/api/status", { cookie: viewerCookie })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/setup", {
        method: "POST",
        body: { token, username: "other", password },
      })
    ).status,
    409,
  );
});

test("public access serves reports and administration without cookies but rejects account APIs and cross-origin writes", async (t) => {
  const { request, token, home, localAdminToken, restart } = await fixture(t);
  const state = await (await request("/api/auth/state")).json();
  assert.equal(state.authenticationEnabled, false);
  assert.equal(state.initialized, false);
  assert.equal(state.user.id, "public");
  assert.equal(state.user.role, "admin");
  await assert.rejects(fs.stat(path.join(home, "setup-token.txt")), { code: "ENOENT" });
  const root = path.join(home, "reports");
  await fs.mkdir(path.join(root, "2026-09-23", "instrument"), {
    recursive: true,
  });
  const reportPath = path.join(root, "2026-09-23", "instrument", "sample.txt");
  await fs.writeFile(
    reportPath,
    "Date 2026-09-23_07-00-00\nSample Name 2 A\nEffective Tests 1\nAVERAGE HARDNESS 0\nTOTAL TESTS 1\nINVALID TESTS 0\nSTEP 0\n1 1 0 0\n",
  );
  const older = new Date(Date.now() - 10000);
  await fs.utimes(reportPath, older, older);
  assert.equal(
    (
      await request("/api/settings", {
        method: "PUT",
        body: { dataPath: root },
        headers: {
          "X-Lizi-Local-Admin": (
            await fs.readFile(path.join(home, "lan-admin-token.txt"), "utf8")
          ).trim(),
        },
      })
    ).status,
    200,
  );
  assert.equal((await request("/api/directories")).status, 200);
  assert.equal(
    (
      await request("/api/scan", {
        method: "POST",
        body: {},
        headers: {
          "X-Lizi-Local-Admin": (
            await fs.readFile(path.join(home, "lan-admin-token.txt"), "utf8")
          ).trim(),
        },
      })
    ).status,
    202,
  );
  let reports;
  const deadline = Date.now() + 10000;
  do {
    reports = await (
      await request("/api/reports?date=2026-09-23&shift=day")
    ).json();
    if (!reports.indexing) break;
    await setTimeout(25);
  } while (Date.now() < deadline);
  assert.equal(reports.indexing, false, "requested date finishes indexing");
  assert.deepEqual(
    reports.reports.map((report) => report.sampleName),
    ["2 A"],
  );
  assert.equal(
    (
      await request("/api/reports/export", {
        method: "POST",
        body: { date: "2026-09-23", shift: "day" },
      })
    ).status,
    200,
  );
  for (const [route, method, body] of [
    ["/api/auth/setup", "POST", { token, username: "admin", password }],
    ["/api/auth/login", "POST", { username: "admin", password }],
    [
      "/api/auth/password",
      "POST",
      { currentPassword: password, password: "different-long-password" },
    ],
    ["/api/auth/logout", "POST", {}],
    ["/api/users", "GET"],
    ["/api/users", "POST", { username: "admin", password, role: "admin" }],
    ["/api/users/public", "PATCH", { password: "different-long-password" }],
    ["/api/access", "PUT", { authenticationEnabled: true }],
  ]) {
    assert.equal((await request(route, {
      method, body, headers: { "X-Lizi-Local-Admin": localAdminToken },
    })).status, 404, route);
  }
  for (const headers of [
    { Origin: "https://attacker.example" },
    { "X-Lizi-Request": "" },
  ]) {
    assert.equal(
      (
        await request("/api/reports/export", {
          method: "POST",
          body: { date: "2026-09-23", shift: "day" },
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/scan", {
        method: "POST", body: {},
        headers: { "X-Lizi-Local-Admin": localAdminToken, ...headers },
      })).status,
      403,
    );
  }
  await restart();
  const restarted = await (await request("/api/auth/state")).json();
  assert.equal(restarted.authenticationEnabled, false);
  assert.equal(restarted.initialized, false);
  assert.equal((await request("/api/reports?date=2026-09-23")).status, 200);
});

test("legacy client accounts and enabled settings cannot impose a login wall", async (t) => {
  const { request, home, restart } = await fixture(t, {
    prepare(home) {
      const db = openDatabase(home);
      setSetting(db, "authenticationEnabled", true);
      db.prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)")
        .run("legacy-user", "legacy-admin", "retained-password-hash", "admin");
      db.close();
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await (await request("/api/auth/state")).json();
    assert.equal(state.authenticationEnabled, false);
    assert.equal(state.user.id, "public");
    assert.equal((await request("/api/reports")).status, 200);
    assert.equal((await request("/api/settings")).status, 200);
    assert.equal((await request("/api/users")).status, 404);
    if (attempt === 0) await restart();
  }
  const db = openDatabase(home);
  try {
    const user = db.prepare("SELECT username,password FROM users WHERE id=?").get("legacy-user");
    assert.equal(user.username, "legacy-admin");
    assert.equal(user.password, "retained-password-hash");
  } finally {
    db.close();
  }
});

test("server password changes revoke existing sessions and streams and survive restart", async (t) => {
  const { request, token, restart } = await fixture(t, { mode: "server" });
  const setup = await request("/api/auth/setup", {
    method: "POST", body: { token, username: "admin", password },
  });
  assert.equal(setup.status, 201);
  const oldCookie = setup.headers.get("set-cookie").split(";")[0];
  const login = await request("/api/auth/login", {
    method: "POST", body: { username: "admin", password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const stream = await request("/api/events", { cookie: oldCookie });
  assert.equal(stream.status, 200);
  const closed = stream.text();
  const changed = await request("/api/auth/password", {
    method: "POST", cookie,
    body: { currentPassword: password, password: "a-different-long-password" },
  });
  assert.equal(changed.status, 200);
  await closed;
  const newCookie = changed.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/reports", { cookie: oldCookie })).status, 401);
  assert.equal((await request("/api/reports", { cookie })).status, 401);
  assert.equal((await request("/api/reports", { cookie: newCookie })).status, 200);
  await restart();
  assert.equal((await request("/api/reports")).status, 401);
  assert.equal((await request("/api/reports", { cookie: newCookie })).status, 200);
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "admin", password },
  })).status, 401);
  const relogin = await request("/api/auth/login", {
    method: "POST", body: { username: "admin", password: "a-different-long-password" },
  });
  assert.equal(relogin.status, 200);
  const reloginCookie = relogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/auth/logout", {
    method: "POST", cookie: reloginCookie, body: {},
  })).status, 200);
  assert.equal((await request("/api/reports", { cookie: reloginCookie })).status, 401);
});
