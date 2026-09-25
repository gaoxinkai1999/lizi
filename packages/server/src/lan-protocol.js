import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { httpError } from "./directories.js";

export const LIMITS = Object.freeze({
  requestMs: 10_000,
  snapshotMs: 120_000,
  snapshotIdleMs: 30_000,
  pairingMs: 180_000,
  rows: 20_000,
  bytes: 32 * 1024 * 1024,
  jsonBytes: 16 * 1024,
  pageRows: 32,
  pageBytes: 512 * 1024,
});

export function privateAddress(address, allowLoopback = false) {
  if (typeof address !== "string" || !net.isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (allowLoopback && a === 127)
  );
}

export function portNumber(value, fallback = 3211, allowZero = false) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535)
    throw httpError(400, "局域网端口必须为1至65535");
  return port;
}

export function normalizeFingerprint(value) {
  if (typeof value !== "string") throw httpError(400, "缺少证书指纹");
  const hex = value
    .replace(/^sha256:/i, "")
    .replaceAll(":", "")
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) throw httpError(400, "证书指纹格式无效");
  return `sha256:${hex}`;
}

export function certificateFingerprint(raw) {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

export function safetyCode(fingerprint, publicKey, nonce) {
  // The full 64-bit comparison prevents a feasible offline search against a six-digit SAS.
  const hex = crypto
    .createHash("sha256")
    .update("lizi-lan-pair-v1\0")
    .update(fingerprint)
    .update("\0")
    .update(publicKey)
    .update("\0")
    .update(nonce)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return hex.match(/.{4}/g).join("-");
}

export function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return (
    first.length === second.length && crypto.timingSafeEqual(first, second)
  );
}

export function tokenHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readBody(stream, limit = LIMITS.jsonBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "局域网消息超过大小限制");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw httpError(400, "局域网消息不是有效JSON对象");
  }
}

export function sendJson(res, value, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

// HTTP only receives the already authenticated TLS socket. No HTTP headers, including
// Authorization, can be queued on an unverified connection. Unpinned mode is info-only.
export async function openRequest(
  peer,
  route,
  {
    method = "GET",
    body,
    token,
    signal,
    timeout = LIMITS.requestMs,
    probe = false,
  } = {},
) {
  if (probe && (route !== "/lan/info" || method !== "GET" || token || body))
    throw httpError(400, "未校验证书只允许发现设备");
  const pin = probe ? null : normalizeFingerprint(peer.fingerprint);
  const agent = new http.Agent({ keepAlive: false });
  let observedFingerprint;
  let tlsSocket;
  agent.createConnection = (_options, callback) => {
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      callback(error, socket);
    };
    tlsSocket = tls.connect({
      host: peer.address,
      port: peer.port,
      rejectUnauthorized: false,
    });
    const handshakeTimer = setTimeout(
      () => tlsSocket.destroy(httpError(504, "TLS连接超时")),
      timeout,
    );
    tlsSocket.once("error", (error) => finish(error));
    tlsSocket.once("secureConnect", () => {
      const certificate = tlsSocket.getPeerCertificate();
      observedFingerprint = certificate?.raw
        ? certificateFingerprint(certificate.raw)
        : null;
      if (!observedFingerprint || (!probe && observedFingerprint !== pin)) {
        tlsSocket.destroy(httpError(495, "TLS证书指纹不匹配，连接已拒绝"));
        return;
      }
      finish(null, tlsSocket);
    });
  };
  let req;
  let timer;
  const abort = () => {
    const reason = httpError(499, "局域网请求已取消");
    tlsSocket?.destroy(reason);
    req?.destroy(reason);
  };
  const dispose = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    req?.destroy();
    tlsSocket?.destroy();
    agent.destroy();
  };
  if (signal?.aborted) {
    dispose();
    throw httpError(499, "局域网请求已取消");
  }
  try {
    const response = await new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      req = http.request(
        {
          hostname: peer.address,
          port: peer.port,
          path: route,
          method,
          agent,
          headers: {
            ...(payload === null
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        resolve,
      );
      req.once("error", reject);
      timer = setTimeout(() => {
        const failure = httpError(504, "局域网请求超时");
        req.destroy(failure);
        tlsSocket?.destroy(failure);
      }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      req.end(payload);
    });
    // The caller owns response lifetime; a stream may replace the initial deadline.
    return {
      response,
      fingerprint: observedFingerprint,
      dispose,
      clearDeadline: () => clearTimeout(timer),
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function requestJson(peer, route, options = {}) {
  const request = await openRequest(peer, route, options);
  try {
    const value = await readBody(request.response, LIMITS.bytes + 64 * 1024);
    if (request.response.statusCode !== 200)
      throw httpError(
        request.response.statusCode,
        value.error || "局域网对端请求失败",
      );
    return options.probe
      ? { ...value, fingerprint: request.fingerprint }
      : value;
  } finally {
    request.dispose();
  }
}
