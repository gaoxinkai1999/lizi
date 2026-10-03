import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApplication } from "../src/app.js";

const setupToken = "cloud-test-bootstrap-token-must-stay-private";

test("中心端始终鉴权，设备令牌独立于浏览器会话且轮换撤销立即生效", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lizi-cloud-auth-"));
  const runtime = await createApplication({ home, mode: "server", setupToken, trustProxy: "1" });
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  await runtime.ready;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  function request(route, method = "GET", body, headers = {}) {
    return fetch(origin + route, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Origin: origin, "X-Lizi-Request": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  assert.equal((await request("/api/reports")).status, 401);
  assert.equal((await request("/api/devices")).status, 401);
  assert.equal((await request("/api/auth/setup", "POST", { token: "wrong", username: "admin", password: "strong-test-password" })).status, 403);
  const setup = await request("/api/auth/setup", "POST", { token: setupToken, username: "admin", password: "strong-test-password" });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get("set-cookie").split(";")[0];
  const proxyHeaders = { Origin: origin.replace("http:", "https:"), "X-Forwarded-Proto": "https" };
  const proxied = await request("/api/auth/login", "POST", { username: "admin", password: "strong-test-password" }, proxyHeaders);
  assert.equal(proxied.status, 200, JSON.stringify(await proxied.json()));
  assert.ok(proxied.headers.get("set-cookie").split(";").some((part) => part.trim() === "Secure"));
  cookie = proxied.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/auth/login", "POST", { username: "admin", password: "strong-test-password" }, { ...proxyHeaders, Origin: "https://attacker.example" })).status, 403);
  assert.equal((await request("/api/access", "PUT", { authenticationEnabled: false })).status, 404);
  assert.equal((await request("/api/lan")).status, 404);
  assert.equal((await request("/api/settings", "PUT", { dataPath: home })).status, 404);
  assert.equal((await request("/api/remote", "PUT", { enabled: true })).status, 404);
  const id = randomUUID();
  const created = await request("/api/devices", "POST", { id, name: "强度仪一", instrumentId: "strength-1", instrumentType: "strength" });
  assert.equal(created.status, 201);
  const { token } = await created.json();
  assert.ok(token.length >= 43);
  const list = await (await request("/api/devices")).text();
  assert.ok(!list.includes(token));
  const heartbeat = { protocolVersion: 1, deviceId: id, pending: 2, oldestPendingAt: "2026-09-28T00:00:00.000Z", lastError: null };
  assert.equal((await request("/api/ingest/heartbeat", "POST", heartbeat)).status, 401);
  // Device uploads are not browser-cookie operations and must work without Origin/CSRF markers.
  const send = (credential, body = heartbeat) => fetch(origin + "/api/ingest/heartbeat", {
    method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  assert.equal((await send(token)).status, 200);
  assert.equal((await send(token, { ...heartbeat, deviceId: randomUUID() })).status, 403);
  const rotation = await request(`/api/devices/${id}/rotate`, "POST", {});
  assert.equal(rotation.status, 200);
  const rotated = (await rotation.json()).token;
  assert.equal((await send(token)).status, 401);
  assert.equal((await send(rotated)).status, 200);
  assert.equal((await request(`/api/devices/${id}`, "DELETE", {})).status, 200);
  assert.equal((await send(rotated)).status, 401);
});
