import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { isDate } from "@lizi/core";
import { httpError } from "./directories.js";
import {
  LIMITS,
  atomicJson,
  certificateFingerprint,
  equalSecret,
  normalizeFingerprint,
  openRequest,
  portNumber,
  privateAddress,
  readBody,
  readJson,
  requestJson,
  safetyCode,
  sendJson,
  tokenHash,
} from "./lan-protocol.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCOVERY_TAG = "lizi-lan-v1";

function deviceName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    /[\x00-\x1f\x7f]/.test(name)
  )
    throw httpError(400, "设备名称须为1至80个可显示字符");
  return name.trim();
}

function addresses(allowLoopback) {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        privateAddress(entry.address, allowLoopback)
      )
        result.push({
          name: name.slice(0, 80),
          address: entry.address,
          netmask: entry.netmask,
        });
      if (result.length >= 32) return result;
    }
  }
  return result;
}

function publicPeer(peer) {
  return peer
    ? {
        id: peer.id,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        fingerprint: peer.fingerprint,
        canQuery: Boolean(peer.token),
      }
    : null;
}

function parseQuery(query) {
  if (
    !query ||
    !isDate(query.date) ||
    !["day", "night", "full"].includes(query.shift) ||
    typeof query.excludeAggregate !== "boolean"
  )
    throw httpError(400, "报告日期或班次筛选无效");
  return {
    date: query.date,
    shift: query.shift,
    excludeAggregate: query.excludeAggregate,
  };
}

export async function createLanManager({ home, store, options = {} }) {
  const manager = new LanManager({ home, store, options });
  await manager.initialize();
  // Never delay the local application's startup for a network bind or certificate.
  manager.start().catch((error) => manager.fail(error));
  return manager;
}

class LanManager extends EventEmitter {
  constructor({ home, store, options }) {
    super();
    this.home = path.resolve(home);
    this.file = path.join(this.home, "lan-settings.json");
    this.identityFile = path.join(this.home, "lan-identity.json");
    this.store = store;
    this.options = {
      port: 3211,
      discoveryPort: 3212,
      bindAddress: "0.0.0.0",
      discovery: true,
      allowLoopback: false,
      ...options,
    };
    this.options.port = portNumber(
      this.options.port,
      3211,
      this.options.allowLoopback,
    );
    this.options.discoveryPort = portNumber(this.options.discoveryPort, 3212);
    this.state = null;
    this.identity = null;
    this.closed = false;
    this.lastError = null;
    this.server = null;
    this.starting = null;
    this.discoverySocket = null;
    this.discoveryJob = null;
    this.discovered = new Map();
    this.pending = null;
    this.joining = null;
    this.openUntil = 0;
    this.nextEnrollment = 0;
    this.sockets = new Set();
    this.streams = new Set();
    this.snapshots = new Map();
    this.openingSnapshots = 0;
    this.fetches = new Set();
    this.operations = new Set();
    this.handlers = new Set();
    this.generation = 0;
    this.connections = new Map();
    this.onRevision = (value) => this.broadcast(value);
    this.store.on("revision", this.onRevision);
    this.mutations = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    const saved = await readJson(this.file);
    if (saved) {
      if (
        !UUID.test(saved.deviceId) ||
        !["standalone", "host", "collector"].includes(saved.mode)
      )
        throw new Error("局域网配置损坏，请恢复lan-settings.json");
      deviceName(saved.name);
      const peers = saved.peers ?? (saved.peer ? [saved.peer] : []);
      if (!Array.isArray(peers) || peers.length > 8 || new Set(peers.map((peer) => peer.id)).size !== peers.length)
        throw new Error("局域网设备列表损坏");
      for (const peer of peers) this.validatePeer(peer);
      saved.peers = peers;
      const migrated = Object.hasOwn(saved, "peer") || Object.hasOwn(saved, "pairing");
      delete saved.peer;
      if (saved.joining && saved.mode !== "standalone") {
        const joining = saved.joining;
        this.validatePeer(joining);
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(joining.ticket) ||
          !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(joining.code) ||
          !Number.isFinite(joining.expiresAt) ||
          joining.status !== "pending"
        )
          throw new Error("局域网配对状态损坏，请恢复lan-settings.json");
        this.joining = { ...joining };
      }
      const pairings = saved.pairings ?? (saved.pairing ? [saved.pairing] : []);
      if (!Array.isArray(pairings) || pairings.length > 8)
        throw new Error("局域网配对状态损坏，请恢复lan-settings.json");
      for (const pairing of pairings) {
        if (!pairing || typeof pairing.id !== "string" ||
            typeof pairing.ticket !== "string" || !Number.isFinite(pairing.expiresAt) ||
            typeof pairing.approved !== "string")
          throw new Error("局域网配对状态损坏，请恢复lan-settings.json");
      }
      saved.pairings = pairings;
      delete saved.pairing;
      this.state = saved;
      if (migrated) await atomicJson(this.file, saved);
    } else {
      this.state = {
        mode: "standalone",
        deviceId: crypto.randomUUID(),
        name: deviceName(os.hostname().slice(0, 80) || "Lizi"),
        peers: [],
        pairings: [],
        epoch: 0,
      };
      await atomicJson(this.file, this.state);
    }
  }

  fail(error) {
    this.lastError = String(error.message || "局域网连接失败").slice(0, 200);
    this.emit("status");
  }

  mutate(action) {
    const operation = this.mutations.then(() => {
      if (this.closed) throw httpError(503, "局域网服务已关闭");
      return action();
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }

  async save(next, configuration = true) {
    await atomicJson(this.file, next);
    this.state = next;
    if (configuration) this.emit("configuration");
    this.emit("status");
  }

  getSettings() {
    return {
      mode: this.state.mode,
      deviceId: this.state.deviceId,
      name: this.state.name,
      port: this.options.port,
      peers: this.state.peers.map(publicPeer),
      epoch: this.state.epoch,
    };
  }

  getStatus() {
    const now = Date.now();
    const pending =
      this.pending && this.pending.expiresAt > now && !this.pending.approved
        ? this.pending
        : null;
    const joining = this.joining;
    return {
      ...this.getSettings(),
      listening: Boolean(this.server?.listening),
      peers: this.state.peers.map((peer) => ({
        ...publicPeer(peer),
        connected: peer.token
          ? Boolean(this.connections.get(peer.id)?.connected)
          : [...this.streams].some((stream) => stream.peerId === peer.id),
        lastError: this.connections.get(peer.id)?.lastError ?? null,
      })),
      connected: [...this.connections.values()].some((connection) => connection.connected) || this.streams.size > 0,
      lastError: this.lastError,
      addresses: addresses(this.options.allowLoopback),
      discovered: [...this.discovered.values()]
        .filter((peer) => peer.seen > now - 60_000)
        .slice(0, 32)
        .map(publicPeer),
      pairing: {
        openUntil: this.openUntil > now ? this.openUntil : null,
        pending: pending
          ? [
              {
                id: pending.id,
                name: pending.name,
                code: pending.code,
                expiresAt: pending.expiresAt,
              },
            ]
          : [],
      },
      joining: joining
        ? {
            id: joining.id,
            name: joining.name,
            code: joining.code,
            status: joining.status,
            expiresAt: joining.expiresAt,
          }
        : null,
    };
  }

  validatePeer(peer) {
    if (
      !peer ||
      !UUID.test(peer.id) ||
      !privateAddress(peer.address, this.options.allowLoopback)
    )
      throw httpError(400, "局域网设备身份或地址无效");
    return {
      id: peer.id,
      name: deviceName(peer.name),
      address: peer.address,
      port: portNumber(peer.port),
      fingerprint: normalizeFingerprint(peer.fingerprint),
    };
  }

  async ensureIdentity() {
    if (this.identity) return;
    let identity = await readJson(this.identityFile);
    if (!identity) {
      const generated = await selfsigned.generate(
        [{ name: "commonName", value: this.state.deviceId }],
        {
          keySize: 2048,
          algorithm: "sha256",
          notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
        },
      );
      identity = { cert: generated.cert, key: generated.private };
      await atomicJson(this.identityFile, identity);
    }
    const certificate = new crypto.X509Certificate(identity.cert);
    const privateKey = crypto.createPrivateKey(identity.key);
    if (!certificate.checkPrivateKey(privateKey))
      throw new Error("局域网证书私钥不匹配");
    this.identity = {
      ...identity,
      fingerprint: certificateFingerprint(certificate.raw),
      publicKey: crypto
        .createPublicKey(privateKey)
        .export({ type: "spki", format: "der" }),
    };
  }

  start() {
    if (this.closed || this.state.mode === "standalone")
      return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startNetwork().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async startNetwork() {
    await this.ensureIdentity();
    if (this.closed || this.state.mode === "standalone") return;
    if (!this.server) {
      const server = https.createServer(
        {
          key: this.identity.key,
          cert: this.identity.cert,
          handshakeTimeout: 5000,
          maxHeaderSize: 8192,
        },
        (req, res) => {
          const operation = this.handle(req, res).catch((error) => {
            if (res.headersSent) res.destroy();
            else
              sendJson(
                res,
                {
                  error: error.status
                    ? String(error.message).slice(0, 200)
                    : "采集端请求失败",
                },
                error.status || 500,
              );
          });
          this.handlers.add(operation);
          operation.finally(() => this.handlers.delete(operation));
        },
      );
      server.maxConnections = 24;
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.keepAliveTimeout = 1000;
      server.setTimeout(30_000, (socket) => socket.destroy());
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
      });
      this.server = server;
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.options.port, this.options.bindAddress, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        this.server = null;
        server.close();
        throw error;
      }
      this.options.port = server.address().port;
      server.on("error", (error) => this.fail(error));
      await this.startDiscovery();
    }
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), 1000);
      this.sweepTimer.unref();
    }
    for (const peer of this.state.peers)
      if (peer.token) this.scheduleReconnect(peer.id, 0);
    if (this.joining?.status === "pending") this.scheduleJoinPoll();
    this.emit("status");
  }

  configure({ mode, name } = {}) {
    return this.mutate(async () => {
      if (!["standalone", "host", "collector"].includes(mode))
        throw httpError(400, "局域网模式无效");
      const nextName = name === undefined ? this.state.name : deviceName(name);
      if (mode !== this.state.mode && this.state.peers.length && mode === "standalone")
        throw httpError(409, "请先断开已配对设备，再切换模式");
      if (mode === this.state.mode && nextName === this.state.name) {
        await this.start();
        return this.getSettings();
      }
      const changedMode = mode !== this.state.mode;
      if (changedMode) {
        this.generation++;
        this.pending = null;
        this.joining = null;
        this.openUntil = 0;
        await this.stopNetwork();
      }
      await this.save({
        ...this.state,
        mode,
        name: nextName,
        joining: changedMode ? null : this.state.joining,
        epoch: this.state.epoch + 1,
      });
      try {
        await this.start();
      } catch (error) {
        this.fail(error);
        throw error;
      }
      return this.getSettings();
    });
  }

  async startDiscovery() {
    if (
      !this.options.discovery ||
      this.discoverySocket ||
      this.state.mode === "standalone"
    )
      return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.discoverySocket = socket;
    let lastReply = 0;
    socket.on("message", (message, remote) => {
      if (
        message.length > 1024 ||
        !privateAddress(remote.address, this.options.allowLoopback) ||
        Date.now() - lastReply < 100
      )
        return;
      let input;
      try {
        input = JSON.parse(message);
      } catch {
        return;
      }
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.tag !== DISCOVERY_TAG ||
        input.type !== "discover" ||
        typeof input.nonce !== "string" ||
        input.nonce.length > 64
      )
        return;
      lastReply = Date.now();
      const reply = Buffer.from(
        JSON.stringify({
          tag: DISCOVERY_TAG,
          type: "collector",
          nonce: input.nonce,
          id: this.state.deviceId,
          name: this.state.name,
          port: this.options.port,
          fingerprint: this.identity.fingerprint,
        }),
      );
      socket.send(reply, remote.port, remote.address, () => {});
    });
    socket.on("error", (error) => this.fail(error));
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(
          this.options.discoveryPort,
          this.options.bindAddress,
          () => {
            socket.off("error", reject);
            resolve();
          },
        );
      });
    } catch (error) {
      this.discoverySocket = null;
      try {
        socket.close();
      } catch {}
      this.fail(error);
    }
  }

  async recordDiscovered(value) {
    const peer = this.validatePeer(value);
    if (peer.id === this.state.deviceId) return;
    this.discovered.delete(peer.id);
    this.discovered.set(peer.id, { ...peer, seen: Date.now() });
    while (this.discovered.size > 32)
      this.discovered.delete(this.discovered.keys().next().value);
    const paired = this.state.peers.find((entry) => entry.id === peer.id);
    if (
      paired &&
      paired.id === peer.id &&
      paired.fingerprint === peer.fingerprint &&
      (paired.address !== peer.address || paired.port !== peer.port)
    ) {
      // Discovery is advisory. Authenticate the endpoint before changing the saved route.
      const info = await this.request(peer, "/lan/info");
      if (info.id !== paired.id) throw httpError(409, "设备身份已变化");
      await this.mutate(async () => {
        if (
          !this.state.peers.some((entry) => entry.id === peer.id && entry.fingerprint === peer.fingerprint)
        )
          return;
        await this.save(
          {
            ...this.state,
            peers: this.state.peers.map((entry) => entry.id === peer.id
              ? { ...entry, address: peer.address, port: peer.port, name: peer.name }
              : entry),
          },
          false,
        );
      });
    }
  }

  async discover({ address, port } = {}) {
    if (this.closed || this.state.mode === "standalone")
      throw httpError(409, "请先启用局域网连接");
    if (address !== undefined) {
      if (!privateAddress(address, this.options.allowLoopback))
        throw httpError(400, "手动探测只允许私网IPv4地址");
      const info = await this.request(
        { address, port: portNumber(port) },
        "/lan/info",
        { probe: true },
      );
      if (info.mode === "standalone") throw httpError(409, "目标未启用局域网连接");
      await this.recordDiscovered({ ...info, address, port: portNumber(port) });
      this.emit("status");
      return this.getStatus();
    }
    if (!this.options.discovery) return this.getStatus();
    if (this.discoveryJob) return this.discoveryJob;
    this.discoveryJob = this.broadcastDiscovery().finally(() => {
      this.discoveryJob = null;
    });
    return this.discoveryJob;
  }

  async broadcastDiscovery() {
    const socket = dgram.createSocket("udp4");
    const nonce = crypto.randomBytes(16).toString("hex");
    const results = new Map();
    socket.on("message", (message, remote) => {
      if (
        message.length > 1024 ||
        !privateAddress(remote.address, this.options.allowLoopback)
      )
        return;
      try {
        const input = JSON.parse(message);
        if (
          input.tag === DISCOVERY_TAG &&
          input.type === "collector" &&
          input.nonce === nonce &&
          results.size < 32
        )
          results.set(
            input.id,
            this.validatePeer({ ...input, address: remote.address }),
          );
      } catch {}
    });
    let timer;
    this.probeSocket = socket;
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", resolve);
        socket.bind(0, () => {
          socket.setBroadcast(true);
          const destinations = new Set();
          for (const entry of addresses(this.options.allowLoopback)) {
            const ip = entry.address.split(".").map(Number);
            const mask = entry.netmask.split(".").map(Number);
            destinations.add(
              ip.map((part, index) => part | (255 ^ mask[index])).join("."),
            );
          }
          if (this.options.allowLoopback) destinations.add("127.0.0.1");
          const message = Buffer.from(
            JSON.stringify({ tag: DISCOVERY_TAG, type: "discover", nonce }),
          );
          for (const destination of destinations)
            socket.send(
              message,
              this.options.discoveryPort,
              destination,
              () => {},
            );
          timer = setTimeout(resolve, 700);
        });
      });
      for (const value of results.values()) await this.recordDiscovered(value);
      this.emit("status");
      return this.getStatus();
    } finally {
      clearTimeout(timer);
      if (this.probeSocket === socket) this.probeSocket = null;
      try {
        socket.close();
      } catch {}
    }
  }

  openPairing() {
    return this.mutate(async () => {
      if (this.state.mode === "standalone")
        throw httpError(409, "请先启用局域网连接");
      if (this.state.peers.length >= 8)
        throw httpError(409, "最多配对8个设备");
      await this.start();
      this.openUntil = Date.now() + LIMITS.pairingMs;
      this.pending = null;
      this.emit("status");
      return this.getStatus();
    });
  }

  join({ address, port, fingerprint } = {}) {
    return this.mutate(async () => {
      if (this.state.mode === "standalone" || this.state.peers.length >= 8)
        throw httpError(409, "请启用局域网连接，最多配对8个设备");
      if (this.joining?.status === "pending")
        throw httpError(409, "已有配对请求，请等待完成或断开");
      if (!privateAddress(address, this.options.allowLoopback))
        throw httpError(400, "只允许私网IPv4地址");
      await this.start();
      const peer = {
        address,
        port: portNumber(port),
        fingerprint: normalizeFingerprint(fingerprint),
      };
      const nonce = crypto.randomBytes(32).toString("base64url");
      const result = await this.request(peer, "/lan/join", {
        method: "POST",
        body: {
          id: this.state.deviceId,
          name: this.state.name,
          port: this.options.port,
          fingerprint: this.identity.fingerprint,
          publicKey: this.identity.publicKey.toString("base64"),
          nonce,
        },
      });
      if (
        typeof result.ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(result.ticket) ||
        !Number.isFinite(result.expiresAt) ||
        result.expiresAt <= Date.now() ||
        result.expiresAt > Date.now() + LIMITS.pairingMs + 5000
      )
        throw httpError(502, "配对响应无效");
      const collector = this.validatePeer({
        id: result.peer.id,
        name: result.peer.name,
        address,
        port: peer.port,
        fingerprint: peer.fingerprint,
      });
      if (collector.id === this.state.deviceId || this.state.peers.some((entry) => entry.id === collector.id))
        throw httpError(409, "设备已配对或不能连接自己");
      const joining = {
        ...collector,
        ticket: result.ticket,
        expiresAt: result.expiresAt,
        status: "pending",
        code: safetyCode(peer.fingerprint, this.identity.publicKey, nonce),
      };
      await this.save({ ...this.state, joining }, false);
      this.joining = { ...joining };
      this.emit("status");
      this.scheduleJoinPoll();
      return this.getStatus();
    });
  }

  scheduleJoinPoll() {
    clearTimeout(this.joinTimer);
    this.joinTimer = setTimeout(
      () => this.pollJoin().catch((error) => this.fail(error)),
      500,
    );
    this.joinTimer.unref();
  }

  finishJoin(joining, status) {
    return this.mutate(async () => {
      if (this.joining !== joining) return;
      await this.save({ ...this.state, joining: null }, false);
      joining.status = status;
      delete joining.ticket;
      this.emit("status");
    });
  }

  async pollJoin() {
    const joining = this.joining;
    if (this.closed || !joining || joining.status !== "pending") return;
    if (joining.expiresAt <= Date.now()) {
      await this.finishJoin(joining, "expired");
      return;
    }
    try {
      const result = await this.request(joining, "/lan/pair-poll", {
        method: "POST",
        body: { ticket: joining.ticket },
      });
      if (this.joining !== joining || this.closed) return;
      if (!result.approved) {
        this.scheduleJoinPoll();
        return;
      }
      const token = crypto
        .privateDecrypt(
          {
            key: this.identity.key,
            oaepHash: "sha256",
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          },
          Buffer.from(result.encryptedToken, "base64"),
        )
        .toString("utf8");
      if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw httpError(502, "配对授权格式无效");
      await this.mutate(async () => {
        if (this.joining !== joining || this.state.peers.some((peer) => peer.id === joining.id)) return;
        if (this.state.peers.length >= 8) throw httpError(409, "最多配对8个设备");
        await this.save({
          ...this.state,
          peers: [...this.state.peers, { ...this.validatePeer(joining), token }],
          joining: null,
          epoch: this.state.epoch + 1,
        });
        joining.status = "approved";
        delete joining.ticket;
        this.emit("status");
        this.scheduleReconnect(joining.id, 0);
      });
    } catch (error) {
      if (this.joining !== joining || this.closed) return;
      this.fail(error);
      if ([403, 404, 410, 495].includes(error.status)) {
        await this.finishJoin(joining, "failed");
      } else this.scheduleJoinPoll();
    }
  }

  async receiveJoin(req) {
    if (
      this.state.mode === "standalone" ||
      this.state.peers.length >= 8 ||
      this.openUntil <= Date.now()
    )
      throw httpError(403, "采集端未打开配对窗口");
    if (this.pending && this.pending.expiresAt > Date.now())
      throw httpError(409, "已有待确认配对请求");
    if (Date.now() < this.nextEnrollment)
      throw httpError(429, "配对请求过于频繁");
    this.nextEnrollment = Date.now() + 3000;
    const input = await readBody(req);
    const address = req.socket.remoteAddress.replace(/^::ffff:/, "");
    const peer = this.validatePeer({ ...input, address });
    if (peer.id === this.state.deviceId || this.state.peers.some((entry) => entry.id === peer.id))
      throw httpError(409, "设备已配对或不能连接自己");
    if (
      typeof input.publicKey !== "string" ||
      input.publicKey.length > 1500 ||
      typeof input.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.nonce)
    )
      throw httpError(400, "配对公钥或随机数无效");
    let key;
    try {
      key = crypto.createPublicKey({
        key: Buffer.from(input.publicKey, "base64"),
        type: "spki",
        format: "der",
      });
    } catch {
      throw httpError(400, "配对公钥无效");
    }
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails.modulusLength < 2048 ||
      key.asymmetricKeyDetails.modulusLength > 4096
    )
      throw httpError(400, "配对公钥必须为2048至4096位RSA");
    const publicKey = key.export({ type: "spki", format: "der" });
    this.pending = {
      ...peer,
      key,
      ticket: crypto.randomBytes(32).toString("base64url"),
      code: safetyCode(this.identity.fingerprint, publicKey, input.nonce),
      expiresAt: this.openUntil,
    };
    this.emit("status");
    return {
      ticket: this.pending.ticket,
      expiresAt: this.pending.expiresAt,
      peer: { id: this.state.deviceId, name: this.state.name },
    };
  }

  approve({ id, code } = {}) {
    return this.mutate(async () => {
      const pending = this.pending;
      if (
        this.state.mode === "standalone" ||
        this.state.peers.length >= 8 ||
        !pending || pending.approved ||
        pending.expiresAt <= Date.now()
      )
        throw httpError(409, "没有有效待确认请求");
      if (id !== pending.id || !equalSecret(code, pending.code))
        throw httpError(403, "两端安全码不匹配");
      const token = crypto.randomBytes(32).toString("base64url");
      const encryptedToken = crypto
        .publicEncrypt(
          {
            key: pending.key,
            oaepHash: "sha256",
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          },
          Buffer.from(token),
        )
        .toString("base64");
      await this.save({
        ...this.state,
        peers: [...this.state.peers, { ...this.validatePeer(pending), tokenHash: tokenHash(token) }],
        pairings: [
          ...this.state.pairings.filter((pairing) => pairing.expiresAt > Date.now()),
          { id: pending.id, ticket: pending.ticket, expiresAt: pending.expiresAt, approved: encryptedToken },
        ],
        epoch: this.state.epoch + 1,
      });
      pending.approved = encryptedToken;
      pending.key = null;
      this.openUntil = 0;
      this.emit("status");
      return this.getStatus();
    });
  }

  async receivePoll(req) {
    const input = await readBody(req);
    const pending = this.state.pairings.find((pairing) => equalSecret(input.ticket, pairing.ticket))
      ?? this.pending;
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      !equalSecret(input.ticket, pending.ticket)
    )
      throw httpError(410, "配对请求已失效");
    return pending.approved
      ? { approved: true, encryptedToken: pending.approved }
      : { approved: false };
  }

  disconnect({ id } = {}) {
    return this.mutate(async () => {
      if (id !== undefined && !this.state.peers.some((peer) => peer.id === id))
        throw httpError(404, "设备未配对");
      const removed = this.state.peers.filter((peer) => id === undefined || peer.id === id);
      if (id === undefined) {
        clearTimeout(this.joinTimer);
        this.joining = null;
        this.pending = null;
        this.openUntil = 0;
      }
      if (id !== undefined && this.pending?.id === id) this.pending = null;
      await this.save({
        ...this.state,
        peers: this.state.peers.filter((peer) => !removed.includes(peer)),
        pairings: this.state.pairings.filter((pairing) => id !== undefined && pairing.id !== id),
        joining: id === undefined ? null : this.state.joining,
        epoch: this.state.epoch + 1,
      });
      for (const peer of removed) {
        this.abortPeer(peer.id);
        await this.releaseCollector(peer.id);
        if (peer.token) {
          try {
            await this.request(peer, "/lan/revoke", {
              method: "POST", body: {}, token: peer.token, timeout: 3000,
            });
          } catch {
            this.lastError = "本机已移除设备；离线设备恢复后请同时撤销对端授权";
          }
        }
      }
      return this.getSettings();
    });
  }

  authenticate(req) {
    const bearer = req.headers.authorization;
    if (typeof bearer !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))
      throw httpError(401, "设备未配对或授权已撤销");
    const hash = tokenHash(bearer.slice(7));
    const peer = this.state.peers.find((peer) => peer.tokenHash && equalSecret(hash, peer.tokenHash));
    if (!peer || this.state.mode === "standalone")
      throw httpError(401, "设备未配对或授权已撤销");
    req.peerId = peer.id;
    return peer;
  }

  async request(peer, route, options = {}) {
    if (!privateAddress(peer.address, this.options.allowLoopback))
      throw httpError(400, "只允许私网IPv4地址");
    const controller = new AbortController();
    this.operations.add(controller);
    controller.peerId = peer.id;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    try {
      return await requestJson(peer, route, { ...options, signal });
    } finally {
      this.operations.delete(controller);
    }
  }

  async fetchReports(query, { peerId, signal } = {}) {
    query = parseQuery(query);
    const peer = this.state.peers.find((peer) => peer.id === peerId);
    if (this.closed || this.state.mode === "standalone" || !peer?.token)
      throw httpError(401, "尚未配对此报告来源");
    if (this.fetches.size >= 2)
      throw httpError(429, "采集端报告请求繁忙，请稍后重试");
    const controller = new AbortController();
    controller.peerId = peer.id;
    this.fetches.add(controller);
    const deadline = setTimeout(() => controller.abort(), LIMITS.snapshotMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const generation = this.generation;
    let snapshot;
    try {
      snapshot = await this.request(peer, "/lan/snapshots", {
        method: "POST",
        body: query,
        token: peer.token,
        signal: combined,
        timeout: 60_000,
      });
      if (
        typeof snapshot.id !== "string" ||
        !/^[a-f0-9]{48}$/.test(snapshot.id) ||
        !Number.isInteger(snapshot.count) ||
        snapshot.count < 0 ||
        snapshot.count > LIMITS.rows ||
        snapshot.sourceId !== peer.id
      )
        throw httpError(502, "采集端快照信息无效");
      const reports = [];
      let bytes = 0;
      let done = false;
      while (!done) {
        const page = await this.request(peer, `/lan/snapshots/${snapshot.id}`, {
          token: peer.token,
          signal: combined,
        });
        if (
          !Array.isArray(page.reports) ||
          typeof page.done !== "boolean" ||
          page.reports.length > LIMITS.pageRows ||
          (!page.done && !page.reports.length)
        )
          throw httpError(502, "采集端快照分页无效");
        for (const report of page.reports) {
          bytes += Buffer.byteLength(JSON.stringify(report));
          if (reports.length >= LIMITS.rows || bytes > LIMITS.bytes)
            throw httpError(413, "采集端报告超过20000行或32MiB限制");
          reports.push(report);
        }
        done = page.done;
      }
      if (
        combined.aborted ||
        generation !== this.generation ||
        !this.state.peers.some((entry) => entry.id === peer.id && entry.token === peer.token)
      )
        throw httpError(499, "报告请求已取消或设备配置已变化");
      if (reports.length !== snapshot.count)
        throw httpError(502, "采集端快照不完整");
      if (!Array.isArray(snapshot.errors) || snapshot.errors.length)
        throw httpError(503, "采集端报告索引不完整");
      return {
        reports,
        revision: snapshot.revision,
        sourceId: peer.id,
        sourceName: snapshot.sourceName,
        errors: [],
      };
    } finally {
      clearTimeout(deadline);
      this.fetches.delete(controller);
      if (snapshot?.id && /^[a-f0-9]{48}$/.test(snapshot.id)) {
        await this.request(peer, `/lan/snapshots/${snapshot.id}`, {
          method: "DELETE",
          token: peer.token,
          timeout: 2000,
        }).catch(() => {});
      }
    }
  }

  async handle(req, res) {
    const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!privateAddress(address, this.options.allowLoopback))
      throw httpError(403, "仅允许私网设备");
    const route = new URL(req.url, "https://lan.invalid").pathname;
    if (req.method === "GET" && route === "/lan/info") {
      sendJson(res, {
        mode: this.state.mode,
        id: this.state.deviceId,
        name: this.state.name,
        port: this.options.port,
        fingerprint: this.identity.fingerprint,
      });
      return;
    }
    if (req.method === "POST" && route === "/lan/join") {
      sendJson(res, await this.receiveJoin(req));
      return;
    }
    if (req.method === "POST" && route === "/lan/pair-poll") {
      sendJson(res, await this.receivePoll(req));
      return;
    }
    const peer = this.authenticate(req);
    if (req.method === "POST" && route === "/lan/revoke") {
      await this.mutate(async () => {
        await this.save({
          ...this.state,
          peers: this.state.peers.filter((entry) => entry.id !== peer.id),
          pairings: this.state.pairings.filter((pairing) => pairing.id !== peer.id),
          epoch: this.state.epoch + 1,
        });
        if (this.pending?.id === peer.id) this.pending = null;
        await this.releaseCollector(peer.id);
      });
      sendJson(res, { revoked: true });
      return;
    }
    if (req.method === "GET" && route === "/lan/events") {
      this.serveEvents(req, res);
      return;
    }
    if (req.method === "POST" && route === "/lan/snapshots") {
      await this.openSnapshot(req, res);
      return;
    }
    const match = /^\/lan\/snapshots\/([a-f0-9]{48})$/.exec(route);
    if (match && this.snapshots.get(match[1])?.peerId !== req.peerId)
      throw httpError(410, "报告快照已过期");
    if (match && req.method === "DELETE") {
      await this.closeSnapshot(match[1]);
      sendJson(res, { closed: true });
      return;
    }
    if (match && req.method === "GET") {
      await this.pageSnapshot(match[1], res);
      return;
    }
    throw httpError(404, "局域网接口不存在");
  }

  async openSnapshot(req, res) {
    const query = parseQuery(await readBody(req));
    if (this.snapshots.size + this.openingSnapshots >= 2)
      throw httpError(429, "最多同时读取两个日期快照");
    if (!this.store.root) throw httpError(409, "采集端尚未选择数据目录");
    this.openingSnapshots++;
    const peer = this.state.peers.find((peer) => peer.id === req.peerId);
    let snapshot;
    try {
      snapshot = await this.store.exportSnapshot(query, { allSelected: true });
      const status = this.store.status();
      if (this.closed || !this.state.peers.includes(peer) || res.destroyed)
        throw httpError(409, "配对或请求已变化");
      if (snapshot.count > LIMITS.rows)
        throw httpError(413, "单个日期快照超过20000行");
      if (status.errors?.length) throw httpError(503, "采集端报告索引不完整");
      const id = crypto.randomBytes(24).toString("hex");
      const session = {
        peerId: req.peerId,
        snapshot,
        iterator: snapshot.reports[Symbol.asyncIterator](),
        touched: Date.now(),
        created: Date.now(),
        rows: 0,
        bytes: 0,
        busy: null,
        closing: false,
      };
      this.snapshots.set(id, session);
      res.once("close", () => {
        if (!res.writableFinished)
          this.closeSnapshot(id).catch((error) => this.fail(error));
      });
      sendJson(res, {
        id,
        count: snapshot.count,
        revision: status.revision,
        sourceId: this.state.deviceId,
        sourceName: this.state.name,
        errors: [],
      });
      snapshot = null;
    } finally {
      this.openingSnapshots--;
      if (snapshot) await snapshot.close();
    }
  }

  async pageSnapshot(id, res) {
    const session = this.snapshots.get(id);
    if (!session || session.closing) throw httpError(410, "报告快照已过期");
    if (session.busy) throw httpError(409, "同一快照不允许并发分页");
    session.touched = Date.now();
    let done = false;
    session.busy = (async () => {
      const reports = [];
      let pageBytes = 0;
      while (reports.length < LIMITS.pageRows && pageBytes < LIMITS.pageBytes) {
        if (res.destroyed || session.closing)
          throw httpError(499, "报告请求已取消");
        const next = await session.iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        const bytes = Buffer.byteLength(JSON.stringify(next.value));
        session.bytes += bytes;
        session.rows++;
        if (session.rows > LIMITS.rows || session.bytes > LIMITS.bytes)
          throw httpError(413, "报告快照超过20000行或32MiB限制");
        reports.push(next.value);
        pageBytes += bytes;
      }
      sendJson(res, { reports, done });
    })();
    try {
      await session.busy;
    } catch (error) {
      done = true;
      throw error;
    } finally {
      session.busy = null;
      if (done || res.destroyed) await this.closeSnapshot(id);
    }
  }

  async closeSnapshot(id) {
    const session = this.snapshots.get(id);
    if (!session) return;
    this.snapshots.delete(id);
    session.closing = true;
    await session.busy?.catch(() => {});
    try {
      await session.iterator.return?.();
    } finally {
      await session.snapshot.close();
    }
  }

  serveEvents(req, res) {
    if (this.streams.size >= 16 || [...this.streams].filter((stream) => stream.peerId === req.peerId).length >= 2)
      throw httpError(429, "事件连接过多");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.flushHeaders();
    res.peerId = req.peerId;
    this.streams.add(res);
    if (this.pending?.id === req.peerId) this.pending = null;
    this.emit("status");
    res.write(
      `event: change\ndata: ${JSON.stringify({ revision: this.store.revision })}\n\n`,
    );
    const heartbeat = setInterval(() => {
      if (!res.write(": heartbeat\n\n")) res.destroy();
    }, 15_000);
    heartbeat.unref();
    res.once("close", () => {
      clearInterval(heartbeat);
      this.streams.delete(res);
      this.emit("status");
    });
  }

  broadcast(value) {
    const revision = Number(value?.revision ?? this.store.revision);
    const message = `event: change\ndata: ${JSON.stringify({ revision })}\n\n`;
    for (const stream of this.streams)
      if (!stream.write(message)) stream.destroy();
  }


  scheduleReconnect(id, delay) {
    const peer = this.state.peers.find((peer) => peer.id === id);
    if (this.closed || this.state.mode === "standalone" || !peer?.token) return;
    let connection = this.connections.get(id);
    if (!connection) {
      connection = { connected: false, lastError: null, delay: 1000 };
      this.connections.set(id, connection);
    }
    if (connection.job || connection.timer) return;
    connection.timer = setTimeout(() => {
      connection.timer = null;
      connection.job = this.connectEvents(peer, connection).finally(() => {
        connection.job = null;
        if (this.connections.get(id) === connection) this.scheduleReconnect(id);
      });
    }, delay ?? connection.delay);
    connection.timer.unref();
  }

  forgetRevokedPeer(peer) {
    return this.mutate(async () => {
      if (!this.state.peers.some((entry) => entry.id === peer.id && entry.token === peer.token)) return;
      this.abortPeer(peer.id);
      await this.save({
        ...this.state,
        peers: this.state.peers.filter((entry) => entry.id !== peer.id),
        epoch: this.state.epoch + 1,
      });
      this.fail(new Error(`${peer.name}已撤销本机授权，请重新配对`));
    });
  }

  async connectEvents(peer, connection) {
    const generation = this.generation;
    const controller = new AbortController();
    connection.controller = controller;
    let opened;
    let idle;
    try {
      opened = await openRequest(peer, "/lan/events", {
        token: peer.token,
        signal: controller.signal,
      });
      if (opened.response.statusCode !== 200)
        throw httpError(opened.response.statusCode, "采集端事件连接被拒绝");
      if (generation !== this.generation || this.closed) return;
      opened.clearDeadline();
      connection.connected = true;
      connection.lastError = null;
      connection.delay = 1000;
      this.emit("status");
      let buffer = "";
      let revision;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), 40_000);
      };
      touch();
      this.emit("change", { peerId: peer.id, reconnected: true });
      opened.response.setEncoding("utf8");
      for await (const chunk of opened.response) {
        touch();
        buffer += chunk;
        if (buffer.length > 16_384) throw httpError(413, "采集端事件消息过大");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = event
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!line || !event.startsWith("event: change\n")) continue;
          const data = JSON.parse(line.slice(6));
          if (!Number.isSafeInteger(data.revision))
            throw httpError(502, "采集端报告版本无效");
          if (data.revision !== revision) {
            const initial = revision === undefined;
            revision = data.revision;
            if (!initial) this.emit("change", { peerId: peer.id, revision });
          }
        }
      }
    } catch (error) {
      if (
        !this.closed && !controller.signal.aborted &&
        (error.status === 401 || error.status === 403) &&
        this.state.peers.some((entry) => entry.id === peer.id && entry.token === peer.token)
      )
        void this.forgetRevokedPeer(peer).catch((cause) => this.fail(cause));
      else if (!this.closed && !controller.signal.aborted) {
        connection.lastError = String(error.message || "局域网连接失败").slice(0, 200);
        this.emit("status");
      }
    } finally {
      clearTimeout(idle);
      opened?.dispose();
      connection.controller = null;
      connection.connected = false;
      connection.delay = Math.min(connection.delay * 2, 30_000);
      this.emit("status");
      if (
        !this.closed &&
        generation === this.generation &&
        this.state.peers.some((entry) => entry.id === peer.id) &&
        this.options.discovery
      )
        this.discover().catch((error) => this.fail(error));
    }
  }

  sweep() {
    const now = Date.now();
    if (this.pending && this.pending.expiresAt <= now) {
      this.pending = null;
      this.emit("status");
    }
    if (this.openUntil && this.openUntil <= now) {
      this.openUntil = 0;
      this.emit("status");
    }
    for (const [id, session] of this.snapshots) {
      if (
        now - session.touched > LIMITS.snapshotIdleMs ||
        now - session.created > LIMITS.snapshotMs
      )
        this.closeSnapshot(id).catch((error) => this.fail(error));
    }
    for (const [id, peer] of this.discovered)
      if (now - peer.seen > 60_000) this.discovered.delete(id);
  }

  abortPeer(id) {
    const connection = this.connections.get(id);
    if (connection) {
      clearTimeout(connection.timer);
      connection.controller?.abort();
      this.connections.delete(id);
    }
    for (const controller of this.operations)
      if (controller.peerId === id) controller.abort();
    for (const controller of this.fetches)
      if (controller.peerId === id) controller.abort();
  }

  abortOutgoing() {
    for (const id of this.connections.keys()) this.abortPeer(id);
    clearTimeout(this.joinTimer);
    for (const controller of this.operations) controller.abort();
    for (const controller of this.fetches) controller.abort();
  }

  async releaseCollector(peerId) {
    for (const stream of this.streams)
      if (peerId === undefined || stream.peerId === peerId) stream.destroy();
    await Promise.all(
      [...this.snapshots].filter(([, session]) => peerId === undefined || session.peerId === peerId)
        .map(([id]) => this.closeSnapshot(id)),
    );
    this.emit("status");
  }

  async stopNetwork() {
    const jobs = [...this.connections.values()].map((connection) => connection.job);
    this.abortOutgoing();
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.starting) await this.starting.catch(() => {});
    await this.releaseCollector();
    for (const socket of this.sockets) socket.destroy();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
    for (const socket of [this.discoverySocket, this.probeSocket]) {
      if (socket) {
        try {
          socket.close();
        } catch {}
      }
    }
    this.discoverySocket = null;
    this.probeSocket = null;
    await Promise.allSettled(jobs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.store.off("revision", this.onRevision);
    await this.mutations;
    await this.stopNetwork();
    await Promise.allSettled([...this.handlers]);
    this.removeAllListeners();
  }
}
