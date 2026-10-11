import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createApplication } from "../src/app.js";

const setupToken = "cloud-test-bootstrap-token-must-stay-private";
const secretValue = () => randomBytes(32).toString("base64url");

test("中心端始终鉴权，设备自助注册经审批后可上传，停用与重新启用立即生效", async (t) => {
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
  // Machine endpoints are bearer-only; they never carry browser cookies or CSRF markers.
  function machine(route, body, secret) {
    return fetch(origin + route, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
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
  assert.equal(proxied.status, 200);
  assert.ok(proxied.headers.get("set-cookie").split(";").some((part) => part.trim() === "Secure"));
  cookie = proxied.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/auth/login", "POST", { username: "admin", password: "strong-test-password" }, { ...proxyHeaders, Origin: "https://attacker.example" })).status, 403);
  assert.equal((await request("/api/access", "PUT", { authenticationEnabled: false })).status, 404);
  assert.equal((await request("/api/lan")).status, 404);
  assert.equal((await request("/api/settings", "PUT", { dataPath: home })).status, 404);
  assert.equal((await request("/api/remote", "PUT", { enabled: true })).status, 404);

  const id = randomUUID();
  const secret = secretValue();
  const enroll = (deviceId, instrumentId, value) => machine("/api/ingest/enroll", { protocolVersion: 1, deviceId, instrumentId, instrumentType: "strength", clientVersion: "3.1.0" }, value);
  const heartbeat = { protocolVersion: 1, deviceId: id, pending: 2, oldestPendingAt: "2026-09-28T00:00:00.000Z", lastError: null, acquisitionError: null, clientVersion: "3.1.0" };

  const first = await enroll(id, "A01", secret);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { protocolVersion: 1, deviceId: id, registrationState: "pending" });
  // Pending devices cannot upload, and other credentials cannot take over the id.
  assert.equal((await machine("/api/ingest/heartbeat", heartbeat, secret)).status, 403);
  assert.equal((await enroll(id, "A01", secretValue())).status, 401);

  const pending = await (await request("/api/devices")).json();
  assert.equal(pending.devices.length, 1);
  assert.equal(pending.devices[0].registrationState, "pending");
  assert.equal(pending.devices[0].connectionState, "pending");
  assert.equal(pending.devices[0].pending, null);
  assert.deepEqual(pending.summary, { pending: 1, online: 0, unstable: 0, offline: 0, revoked: 0, errors: 0 });
  assert.equal((await (await request("/api/devices")).text()).includes(secret), false);

  assert.equal((await request(`/api/devices/${id}/approve`, "POST", {})).status, 200);
  const approvedBeat = await machine("/api/ingest/heartbeat", heartbeat, secret);
  assert.equal(approvedBeat.status, 200);
  assert.equal((await approvedBeat.json()).registrationState, "approved");
  assert.equal((await request(`/api/devices/${id}`, "PATCH", { name: "强度仪一", location: "一号车间" })).status, 200);
  const listed = await (await request("/api/devices")).json();
  assert.equal(listed.devices[0].name, "强度仪一");
  assert.equal(listed.devices[0].location, "一号车间");
  assert.equal(listed.devices[0].instrumentId, "A01");
  assert.equal(listed.devices[0].connectionState, "online");
  assert.equal(listed.devices[0].clientVersion, "3.1.0");
  assert.equal(listed.summary.online, 1);

  // Stopping withdraws upload permission immediately; re-approval restores the same credential.
  assert.equal((await request(`/api/devices/${id}`, "DELETE", {})).status, 200);
  assert.equal((await machine("/api/ingest/heartbeat", heartbeat, secret)).status, 401);
  const revokedEnroll = await enroll(id, "A01", secret);
  assert.equal(revokedEnroll.status, 200);
  assert.deepEqual(await revokedEnroll.json(), { protocolVersion: 1, deviceId: id, registrationState: "revoked" });
  assert.equal((await request(`/api/devices/${id}/approve`, "POST", {})).status, 200);
  assert.equal((await machine("/api/ingest/heartbeat", heartbeat, secret)).status, 200);

  // The 3.0 manual register/rotate endpoints no longer exist.
  assert.equal((await request("/api/devices", "POST", { id: randomUUID(), name: "x", instrumentId: "B01", instrumentType: "strength" })).status, 404);
  assert.equal((await request(`/api/devices/${id}/rotate`, "POST", {})).status, 404);

  // Viewers cannot administer devices.
  assert.equal((await request("/api/users", "POST", { username: "viewer1", password: "strong-test-password", role: "viewer" })).status, 201);
  const viewerLogin = await request("/api/auth/login", "POST", { username: "viewer1", password: "strong-test-password" });
  assert.equal(viewerLogin.status, 200);
  cookie = viewerLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/devices")).status, 403);
  assert.equal((await request(`/api/devices/${id}/approve`, "POST", {})).status, 403);
});
