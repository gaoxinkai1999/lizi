import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createApplication } from "../src/app.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-auth-"));
  const token = "a-secure-one-time-bootstrap-token-for-tests";
  let runtime;
  let server;
  let origin;
  async function start() {
    runtime = await createApplication({
      home,
      setupToken: token,
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
  t.after(async () => {
    await stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function request(
    route,
    { method = "GET", body, cookie, headers = {} } = {},
  ) {
    return fetch(`${origin}${route}`, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Lizi-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return {
    request,
    token,
    home,
    setAccess: (authenticationEnabled, cookie) =>
      request("/api/access", {
        method: "PUT",
        body: { authenticationEnabled },
        cookie,
      }),
    async restart() {
      await stop();
      await start();
    },
  };
}

const password = "a-password-long-enough";

test("bootstrap needs a token and same-origin marker; sessions enforce role and immediate disable", async (t) => {
  const { request, token, setAccess } = await fixture(t);
  assert.equal((await setAccess(true)).status, 200);
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
  const added = await request("/api/users", {
    method: "POST",
    cookie,
    body: { username: "viewer", password, role: "viewer" },
  });
  const viewer = (await added.json()).user;
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "viewer", password },
  });
  const viewerCookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await request("/api/status", { cookie: viewerCookie })).status,
    200,
  );
  assert.equal(
    (await request("/api/settings", { cookie: viewerCookie })).status,
    403,
  );
  assert.equal((await setAccess(false, viewerCookie)).status, 403);
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
  const { request, token, home, restart } = await fixture(t);
  const state = await (await request("/api/auth/state")).json();
  assert.equal(state.authenticationEnabled, false);
  assert.equal(state.initialized, false);
  assert.deepEqual(state.user, {
    id: "public",
    username: "公开访问",
    role: "admin",
  });
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
      })
    ).status,
    200,
  );
  assert.equal((await request("/api/directories")).status, 200);
  assert.equal(
    (await request("/api/scan", { method: "POST", body: {} })).status,
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
  ]) {
    assert.equal((await request(route, { method, body })).status, 409, route);
  }
  for (const headers of [
    { Origin: "https://attacker.example" },
    { "X-Lizi-Request": "" },
  ]) {
    assert.equal(
      (
        await request("/api/access", {
          method: "PUT",
          body: { authenticationEnabled: true },
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/scan", { method: "POST", body: {}, headers }))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await request("/api/access", {
        method: "PUT",
        body: { authenticationEnabled: "true" },
      })
    ).status,
    400,
  );
  await restart();
  const restarted = await (await request("/api/auth/state")).json();
  assert.equal(restarted.authenticationEnabled, false);
  assert.equal(restarted.initialized, false);
  assert.equal((await request("/api/reports?date=2026-09-23")).status, 200);
});

test("access changes close every stream, revoke old sessions, preserve accounts and persist across restart", async (t) => {
  const { request, token, setAccess, restart } = await fixture(t);
  const publicStreams = await Promise.all(
    Array.from({ length: 9 }, () => request("/api/events")),
  );
  for (const stream of publicStreams) assert.equal(stream.status, 200);
  const publicClosed = publicStreams.map((stream) => stream.text());
  assert.deepEqual(await (await setAccess(true)).json(), {
    authenticationEnabled: true,
    initialized: false,
  });
  for (const stream of await Promise.all(publicClosed)) {
    assert.match(
      stream,
      /event: access\ndata: \{"authenticationEnabled":true\}\n\n$/,
    );
  }
  assert.equal((await request("/api/events")).status, 401);
  assert.equal((await request("/api/reports")).status, 401);
  assert.equal((await setAccess(false)).status, 401);
  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { token, username: "admin", password },
  });
  assert.equal(setup.status, 201);
  const admin = (await setup.json()).user;
  const setupCookie = setup.headers.get("set-cookie").split(";")[0];
  await restart();
  const enabledState = await (await request("/api/auth/state")).json();
  assert.equal(enabledState.authenticationEnabled, true);
  assert.equal(enabledState.initialized, true);
  assert.equal(enabledState.user, null);
  assert.equal((await request("/api/reports")).status, 401);
  assert.equal(
    (await request("/api/settings", { cookie: setupCookie })).status,
    200,
  );
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const authenticatedStreams = await Promise.all([
    request("/api/events", { cookie: setupCookie }),
    request("/api/events", { cookie }),
  ]);
  for (const stream of authenticatedStreams) assert.equal(stream.status, 200);
  const authenticatedClosed = authenticatedStreams.map((stream) =>
    stream.text(),
  );
  assert.deepEqual(await (await setAccess(false, cookie)).json(), {
    authenticationEnabled: false,
    initialized: true,
  });
  for (const stream of await Promise.all(authenticatedClosed)) {
    assert.match(
      stream,
      /event: access\ndata: \{"authenticationEnabled":false\}\n\n$/,
    );
  }
  assert.equal((await request("/api/reports")).status, 200);
  const publicState = await (
    await request("/api/auth/state", { cookie })
  ).json();
  assert.equal(publicState.authenticationEnabled, false);
  assert.equal(publicState.initialized, true);
  assert.equal(publicState.user.id, "public");
  assert.equal(
    (
      await request(`/api/users/${admin.id}`, {
        method: "PATCH",
        cookie,
        body: { password: "different-long-password" },
      })
    ).status,
    409,
  );
  await restart();
  const settings = await (await request("/api/settings")).json();
  assert.equal(settings.authenticationEnabled, false);
  assert.equal((await setAccess(true)).status, 200);
  assert.equal((await request("/api/reports", { cookie })).status, 401);
  assert.equal(
    (await request("/api/reports", { cookie: setupCookie })).status,
    401,
  );
  const relogin = await request("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password },
  });
  assert.equal(relogin.status, 200);
  assert.deepEqual((await relogin.json()).user, admin);
});
