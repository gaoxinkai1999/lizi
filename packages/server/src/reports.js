import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { databaseLocation, getSetting } from "./database.js";
import { httpError } from "./directories.js";

export class ReportStore extends EventEmitter {
  constructor(db, directories) {
    super();
    this.directories = directories;
    this.root = getSetting(db, "dataPath");
    this.revision = Number(getSetting(db, "revision", "0"));
    this.errors = [];
    this.closed = false;
    this.pending = new Map();
    this.sequence = 0;
    this.cachedStatus = {
      root: this.root,
      revision: this.revision,
      reportCount: 0,
      watching: false,
      scanning: false,
      lastScan: null,
      errors: [],
      scanProgress: {
        phase: "idle",
        visited: 0,
        indexed: 0,
        invalid: 0,
        changed: 0,
        startedAt: null,
      },
    };
    this.worker = new Worker(new URL("./report-worker.js", import.meta.url), {
      workerData: {
        database: databaseLocation(db),
        allowedRoots: directories.allowedRoots,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 384,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Construction may precede start(); retain a rejection handler until a caller awaits it.
    this.ready.catch(() => {});
    this.worker.on("message", (message) => {
      if (message.type === "status") {
        const previous = this.revision;
        this.cachedStatus = message.status;
        this.root = message.status.root;
        this.revision = message.status.revision;
        this.errors = message.status.errors;
        if (previous !== this.revision)
          this.emit("revision", { revision: this.revision });
        this.emit("status", this.status());
      } else if (message.type === "ready") {
        this.resolveReady();
      } else {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error)
          request.reject(
            httpError(message.error.status ?? 500, message.error.message),
          );
        else request.resolve(message.result);
      }
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed)
        this.fail(
          new Error(`报告索引工作线程已退出 (${code})，请重启服务后重试`),
        );
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.cachedStatus = {
      ...this.cachedStatus,
      watching: false,
      scanning: false,
      errors: [
        { path: this.root, message: `报告索引不可用：${error.message}` },
      ],
      scanProgress: { ...this.cachedStatus.scanProgress, phase: "failed" },
    };
    this.errors = this.cachedStatus.errors;
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.emit("status", this.status());
  }

  async request(method, params) {
    if (this.closed) throw httpError(503, "报告索引已关闭");
    await this.ready;
    if (this.failure) throw httpError(503, this.failure.message);
    if (
      this.pending.size >= 8 &&
      !["close", "exportClose", "exportEnd"].includes(method)
    )
      throw httpError(503, "报告请求繁忙，请稍后重试");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params });
    });
  }

  async start() {
    await this.ready;
  }

  status() {
    return {
      ...this.cachedStatus,
      errors: [...this.cachedStatus.errors],
      scanProgress: { ...this.cachedStatus.scanProgress },
    };
  }

  async setRoot(root) {
    const canonical = await this.directories.resolveDirectory(root);
    return this.request("setRoot", { root: canonical });
  }

  scan() {
    return this.request("scan");
  }

  query(params) {
    return this.request("query", params);
  }

  async exportSnapshot(query, selection = {}) {
    const snapshot = await this.request("exportOpen", { query, selection });
    let closed = false;
    let reading = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (!this.closed && !this.failure)
        await this.request("exportClose", { token: snapshot.token });
    };
    const store = this;
    const reports = {
      async *[Symbol.asyncIterator]() {
        if (closed) throw httpError(410, "导出快照已关闭");
        if (reading) throw httpError(409, "同一导出快照不能并发读取");
        reading = true;
        let start = true;
        try {
          while (!closed) {
            const page = await store.request("exportNext", {
              token: snapshot.token,
              start,
            });
            start = false;
            for (const report of page.reports) yield report;
            if (page.done) break;
          }
        } finally {
          reading = false;
          if (!closed && !store.closed && !store.failure) {
            await store.request("exportEnd", { token: snapshot.token });
          }
        }
      },
    };
    return {
      count: snapshot.count,
      detailCount: snapshot.detailCount,
      reports,
      close,
    };
  }

  async close() {
    if (this.closed) return;
    const worker = this.worker;
    const shutdown = this.failure
      ? Promise.resolve()
      : this.request("close").catch(() => {});
    this.closed = true;
    let timeout;
    try {
      await Promise.race([
        shutdown,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
      for (const request of this.pending.values())
        request.reject(httpError(503, "报告索引已关闭"));
      this.pending.clear();
      this.cachedStatus = {
        ...this.cachedStatus,
        watching: false,
        scanning: false,
      };
    }
  }
}
