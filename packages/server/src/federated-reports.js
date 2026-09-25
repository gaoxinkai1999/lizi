import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { shiftBounds } from "@lizi/core";
import { httpError } from "./directories.js";

const MiB = 1024 * 1024;
const TEMPORARY_CLIENT = Symbol("temporary report lease");
function compare(a, b) {
  const left = `${a.date}T${a.time}`;
  const right = `${b.date}T${b.time}`;
  if (left !== right) return left < right ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function scopeQuery(params) {
  const query = {
    date: params.date,
    shift: params.shift ?? "day",
    excludeAggregate: Boolean(params.excludeAggregate),
  };
  try {
    shiftBounds(query.date, query.shift);
  } catch (error) {
    throw httpError(400, error.message);
  }
  return query;
}

function keyOf(query) {
  return `${query.date}/${query.shift}/${Number(query.excludeAggregate)}`;
}

function freezeReport(report) {
  for (const rows of [report.testResults, report.segmentInfoList]) {
    for (const row of rows) Object.freeze(row);
    Object.freeze(rows);
  }
  return Object.freeze(report);
}

export class FederatedReportStore extends EventEmitter {
  constructor(localStore, lan, options = {}) {
    super();
    this.local = localStore;
    this.lan = lan;
    this.revision = localStore.revision;
    this.closed = false;
    this.scopes = new Map();
    this.clients = new Map();
    this.generations = new Set();
    this.snapshots = new Set();
    this.openingSnapshots = 0;
    this.now = options.now ?? Date.now;
    this.ttl = Math.max(60000, Math.min(120000, options.ttlMs ?? 60000));
    this.maxBytes = Math.min(64 * MiB, options.maxBytes ?? 64 * MiB);
    this.maxRemoteBytes = Math.min(
      32 * MiB,
      this.maxBytes,
      options.maxRemoteBytes ?? 32 * MiB,
    );
    this.maxScopes = Math.min(4, options.maxScopes ?? 4);
    this.maxClients = Math.min(128, options.maxClients ?? 128);
    this.reservedBytes = 0;
    this.selectionBytes = 0;
    this.refreshing = false;
    this.connected = Boolean(lan.getStatus().connected);
    this.listeners = [
      [localStore, "revision", () => this.changed()],
      [localStore, "status", () => this.emit("status", this.status())],
      [
        lan,
        "configuration",
        () => {
          this.clearScopes();
          for (const snapshot of this.snapshots)
            void snapshot.close().catch(() => {});
          this.connected = Boolean(lan.getStatus().connected);
          this.changed();
        },
      ],
      [lan, "change", () => this.invalidate()],
      [
        lan,
        "status",
        () => {
          const connected = Boolean(lan.getStatus().connected);
          if (connected && !this.connected) this.invalidate();
          this.connected = connected;
          this.changed();
        },
      ],
    ];
    for (const [emitter, event, listener] of this.listeners)
      emitter.on(event, listener);
    this.maintenance = setInterval(() => {
      this.expire();
      this.invalidate();
    }, 30000);
    this.maintenance.unref();
  }

  get root() {
    return this.local.root;
  }
  get errors() {
    return this.local.errors;
  }
  start() {
    return this.local.start();
  }
  setRoot(root) {
    return this.local.setRoot(root);
  }
  scan() {
    return this.local.scan();
  }
  getStatus() {
    return this.status();
  }

  paired() {
    const settings = this.lan.getSettings();
    return settings.mode === "host" && Boolean(settings.peer);
  }

  memoryBytes() {
    let bytes = this.reservedBytes + this.selectionBytes;
    for (const generation of this.generations) bytes += generation.bytes;
    return bytes;
  }

  status() {
    const local = this.local.status();
    return {
      ...local,
      revision: this.revision,
      cacheEpoch: this.lan.getSettings().epoch,
      lan: this.lan.getStatus(),
      cache: {
        scopes: this.scopes.size,
        clients: this.clients.size,
        bytes: this.memoryBytes(),
        maxBytes: this.maxBytes,
        reservedBytes: this.reservedBytes,
        snapshots: this.snapshots.size + this.openingSnapshots,
        reports: [...this.scopes.values()].reduce(
          (sum, scope) => sum + (scope.generation?.rows.length ?? 0),
          0,
        ),
      },
    };
  }

  changed() {
    if (this.closed) return;
    this.revision += 1;
    this.emit("revision", { revision: this.revision });
    this.emit("status", this.status());
  }

  expire() {
    const now = this.now();
    for (const [id, client] of this.clients)
      if (now - client.touched >= this.ttl) this.release(id);
    for (const snapshot of this.snapshots) {
      if (now - snapshot.touched >= 120000)
        void snapshot.close().catch(() => {});
    }
  }

  touch(params, clientId = params.clientId) {
    if (this.closed) throw httpError(503, "报告索引已关闭");
    if (!this.paired()) return;
    this.expire();
    const query = scopeQuery(params);
    const key = keyOf(query);
    const id = clientId || TEMPORARY_CLIENT;
    const previous = this.clients.get(id);
    if (!previous && this.clients.size >= this.maxClients)
      throw httpError(503, "双机报告查看客户端已达上限");
    let scope = this.scopes.get(key);
    if (!scope && this.scopes.size >= this.maxScopes) {
      const replaceable =
        previous && this.scopes.get(previous.key)?.clients.size === 1;
      if (!replaceable)
        throw httpError(503, "同时最多查看四个双机日期班次，请先关闭其他查询");
    }
    if (previous && previous.key !== key) this.release(id);
    if (!scope) {
      scope = {
        key,
        query,
        clients: new Set(),
        generation: null,
        pending: true,
        loading: true,
        warning: null,
        controller: null,
      };
      this.scopes.set(key, scope);
      this.schedule();
    }
    scope.clients.add(id);
    this.clients.set(id, { key, touched: this.now() });
    return scope;
  }

  release(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    const scope = this.scopes.get(client.key);
    if (!scope) return;
    scope.clients.delete(clientId);
    if (scope.clients.size) return;
    this.scopes.delete(client.key);
    scope.controller?.abort();
    this.unref(scope.generation);
    scope.generation = null;
  }

  clearScopes() {
    for (const clientId of this.clients.keys()) this.release(clientId);
  }

  unref(generation) {
    if (generation && --generation.refs === 0)
      this.generations.delete(generation);
  }

  invalidate() {
    if (this.closed || !this.paired()) return;
    for (const scope of this.scopes.values()) {
      scope.pending = true;
      scope.loading = true;
    }
    this.schedule();
  }

  schedule() {
    if (this.closed || this.refreshTimer || this.refreshing) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshPromise = this.refresh();
    }, 25);
    this.refreshTimer.unref();
  }

  async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      for (const scope of this.scopes.values()) {
        if (!scope.pending) continue;
        scope.pending = false;
        const controller = new AbortController();
        scope.controller = controller;
        let reserved = false;
        try {
          if (!this.lan.getStatus().connected)
            throw httpError(503, "采集端离线，显示上次缓存的数据");
          // Reserve one bounded transport result before allocating it. Old generations
          // held by an export/query remain charged until their final reader releases.
          if (this.memoryBytes() + this.maxRemoteBytes > this.maxBytes)
            throw httpError(
              503,
              "双机缓存内存已达上限，请关闭导出或其他日期查询",
            );
          this.reservedBytes += this.maxRemoteBytes;
          reserved = true;
          const result = await this.lan.fetchReports(scope.query, {
            signal: controller.signal,
          });
          if (
            this.closed ||
            this.scopes.get(scope.key) !== scope ||
            controller.signal.aborted
          )
            continue;
          if (!Array.isArray(result.reports) || result.reports.length > 20000)
            throw httpError(413, "采集端报告数量超过缓存上限");
          const { peer } = this.lan.getSettings();
          if (result.sourceId !== peer.id)
            throw httpError(409, "采集端身份已变化，请重新查询");
          const { start, end } = shiftBounds(
            scope.query.date,
            scope.query.shift,
          );
          const ids = new Set();
          let bytes = 0;
          const rows = [];
          for (const report of result.reports) {
            if (
              !/^[a-f0-9]{32}$/.test(report.id) ||
              !Array.isArray(report.testResults) ||
              !Array.isArray(report.segmentInfoList)
            )
              throw httpError(502, "采集端报告格式无效");
            const timestamp = `${report.date}T${report.time}`;
            if (
              timestamp < start ||
              timestamp >= end ||
              (scope.query.excludeAggregate && report.isAggregate)
            )
              continue;
            const id = createHash("sha256")
              .update(`${peer.id}\0${report.id}`)
              .digest("hex")
              .slice(0, 32);
            if (ids.has(id)) throw httpError(502, "采集端返回重复报告");
            ids.add(id);
            const row = {
              ...report,
              id,
              sourceId: peer.id,
              sourceName: result.sourceName || peer.name,
            };
            // Account serialized payload plus row/reference bookkeeping. This is a
            // bounded cache budget, not a claim about V8's exact heap overhead.
            bytes += Buffer.byteLength(JSON.stringify(row)) + 128;
            if (bytes > this.maxRemoteBytes)
              throw httpError(413, "采集端报告超过单次缓存内存上限");
            rows.push(freezeReport(row));
          }
          rows.sort(compare);
          const generation = { rows: Object.freeze(rows), bytes, refs: 1 };
          this.unref(scope.generation);
          scope.generation = generation;
          this.generations.add(generation);
          scope.warning = result.errors?.length
            ? "采集端部分报告未完整读取，请检查采集端索引状态"
            : null;
        } catch (error) {
          if (
            this.scopes.get(scope.key) === scope &&
            !controller.signal.aborted
          )
            scope.warning = error.message || "采集端同步失败";
        } finally {
          if (reserved) this.reservedBytes -= this.maxRemoteBytes;
          scope.controller = null;
          scope.loading = scope.pending;
          if (this.scopes.get(scope.key) === scope) this.changed();
        }
      }
    } finally {
      this.refreshing = false;
      if ([...this.scopes.values()].some((scope) => scope.pending))
        this.schedule();
    }
  }

  metadata(scope) {
    const settings = this.lan.getSettings();
    const sources = [
      { id: settings.deviceId, name: settings.name, state: "local" },
    ];
    const warnings = [];
    if (this.paired()) {
      const online = this.lan.getStatus().connected;
      let warning = scope?.warning;
      if (!online) warning = "采集端离线，远端数据可能不完整；已有缓存予以保留";
      if (warning) warnings.push(warning);
      let state = "ready";
      if (!online) state = "offline";
      else if (scope?.loading || !scope?.generation) state = "syncing";
      else if (warning) state = "error";
      sources.push({
        id: settings.peer.id,
        name: settings.peer.name,
        state,
        ...(warning ? { warning } : {}),
      });
    }
    return { transient: this.paired(), sources, warnings };
  }

  async query(params) {
    const scope = this.touch(params);
    let generation;
    try {
      const page = await this.local.query(params);
      generation = scope?.generation;
      if (generation) generation.refs += 1;
      const revision = this.revision;
      const settings = this.lan.getSettings();
      const localRow = (row) => ({
        ...row,
        sourceId: settings.deviceId,
        sourceName: settings.name,
      });
      let reports = page.reports.map(localRow);
      let total = page.total;
      if (generation?.rows.length) {
        const remote = generation.rows;
        total += remote.length;
        const offset = Math.min((page.page - 1) * page.pageSize, total);
        let cached = page;
        const localAt = async (index, singleton = false) => {
          if (index < 0 || index >= page.total) return null;
          const size = singleton ? 1 : page.pageSize;
          const number = Math.floor(index / size) + 1;
          if (cached.page !== number || cached.pageSize !== size) {
            cached = await this.local.query({
              ...params,
              page: number,
              pageSize: size,
            });
            if (
              cached.revision !== page.revision ||
              cached.total !== page.total
            )
              throw httpError(409, "报告正在更新，请重新查询");
          }
          return cached.reports[index % size];
        };
        // Partition the two ordered sources at the requested offset. Deep pages
        // need O(log remote-count) one-row lookups, not a local-history scan.
        let low = Math.max(0, offset - page.total);
        let high = Math.min(offset, remote.length);
        let remoteIndex = low;
        while (low <= high) {
          const candidate = Math.floor((low + high) / 2);
          const localIndex = offset - candidate;
          const before = await localAt(localIndex - 1, true);
          const after = await localAt(localIndex, true);
          if (
            candidate > 0 &&
            after &&
            compare(remote[candidate - 1], after) > 0
          )
            high = candidate - 1;
          else if (
            candidate < remote.length &&
            before &&
            compare(before, remote[candidate]) > 0
          )
            low = candidate + 1;
          else {
            remoteIndex = candidate;
            break;
          }
        }
        let localIndex = offset - remoteIndex;
        reports = [];
        while (
          reports.length < page.pageSize &&
          (localIndex < page.total || remoteIndex < remote.length)
        ) {
          const local = await localAt(localIndex);
          const distant = remote[remoteIndex];
          if (distant && (!local || compare(distant, local) < 0)) {
            reports.push(distant);
            remoteIndex += 1;
          } else {
            reports.push(localRow(local));
            localIndex += 1;
          }
        }
      }
      if (scope && this.scopes.get(scope.key) !== scope)
        throw httpError(409, "查询日期或双机配置已经变化，请重新查询");
      let pageBytes = 0;
      for (const report of reports) {
        pageBytes += Buffer.byteLength(JSON.stringify(report));
        if (pageBytes > 24 * MiB)
          throw httpError(413, "本页明细过大，请减小每页报告数量");
      }
      return {
        ...page,
        reports,
        total,
        revision,
        indexing: page.indexing || Boolean(scope?.loading),
        incomplete: Boolean(
          scope &&
          (!scope.generation ||
            scope.loading ||
            scope.warning ||
            !this.lan.getStatus().connected),
        ),
        ...this.metadata(scope),
      };
    } finally {
      this.unref(generation);
    }
  }

  async exportSnapshot(params, selection = {}) {
    if (this.closed) throw httpError(503, "报告索引已关闭");
    this.expire();
    if (this.snapshots.size + this.openingSnapshots >= 2)
      throw httpError(429, "同时最多导出两个快照，请稍后重试");
    const settings = this.lan.getSettings();
    const query = scopeQuery(params);
    const scope = this.paired() ? this.scopes.get(keyOf(query)) : null;
    if (this.paired()) {
      if (!this.lan.getStatus().connected)
        throw httpError(503, "采集端离线，不能导出不完整的双机报告");
      if (!scope?.generation || scope.loading)
        throw httpError(409, "采集端报告尚未同步完成，请先查询并稍后导出");
      if (scope.warning) throw httpError(503, scope.warning);
    }
    let generation = scope?.generation;
    if (generation) generation.refs += 1;
    this.openingSnapshots += 1;
    let localSnapshot;
    let selectionBytes = 0;
    try {
      const explicit =
        Array.isArray(selection.ids) || selection.allSelected === true;
      const remoteIds = new Set(generation?.rows.map((row) => row.id));
      const selectedIds = Array.isArray(selection.ids)
        ? new Set(selection.ids)
        : null;
      const rows = (generation?.rows ?? []).filter(
        (row) =>
          (!row.isAggregate || (explicit && !query.excludeAggregate)) &&
          (!selectedIds || selectedIds.has(row.id)),
      );
      if (this.memoryBytes() + rows.length * 8 > this.maxBytes)
        throw httpError(503, "双机导出缓存内存已达上限");
      selectionBytes = rows.length * 8;
      this.selectionBytes += selectionBytes;
      localSnapshot = await this.local.exportSnapshot(
        query,
        selectedIds
          ? { ids: [...selectedIds].filter((id) => !remoteIds.has(id)) }
          : selection,
      );
      if (
        this.closed ||
        settings.epoch !== this.lan.getSettings().epoch ||
        (scope &&
          (this.scopes.get(scope.key) !== scope ||
            scope.loading ||
            scope.warning ||
            !this.lan.getStatus().connected))
      )
        throw httpError(409, "双机报告状态已经变化，请重新查询后导出");
      const detailCount =
        localSnapshot.detailCount +
        rows.reduce(
          (sum, row) =>
            sum + row.testResults.length + row.segmentInfoList.length,
          0,
        );
      if (detailCount > 500000)
        throw httpError(413, "测试明细超过50万行，请分批选择导出");
      const store = this;
      let closed = false;
      let reading = false;
      const snapshot = {
        count: localSnapshot.count + rows.length,
        detailCount,
        touched: this.now(),
        reports: {
          async *[Symbol.asyncIterator]() {
            if (closed) throw httpError(410, "导出快照已关闭");
            if (reading) throw httpError(409, "同一导出快照不能并发读取");
            reading = true;
            const iterator = localSnapshot.reports[Symbol.asyncIterator]();
            let remoteIndex = 0;
            try {
              let local = await iterator.next();
              while (!local.done || remoteIndex < rows.length) {
                if (closed) throw httpError(410, "导出快照已关闭");
                snapshot.touched = store.now();
                if (
                  remoteIndex < rows.length &&
                  (local.done || compare(rows[remoteIndex], local.value) < 0)
                )
                  yield rows[remoteIndex++];
                else {
                  yield {
                    ...local.value,
                    sourceId: settings.deviceId,
                    sourceName: settings.name,
                  };
                  local = await iterator.next();
                }
              }
            } finally {
              reading = false;
              await iterator.return?.();
            }
          },
        },
        async close() {
          if (closed) return;
          closed = true;
          store.snapshots.delete(snapshot);
          store.selectionBytes -= selectionBytes;
          store.unref(generation);
          generation = null;
          rows.length = 0;
          await localSnapshot.close();
        },
      };
      this.snapshots.add(snapshot);
      return snapshot;
    } catch (error) {
      this.selectionBytes -= selectionBytes;
      this.unref(generation);
      if (localSnapshot) await localSnapshot.close();
      throw error;
    } finally {
      this.openingSnapshots -= 1;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.refreshTimer);
    clearInterval(this.maintenance);
    for (const [emitter, event, listener] of this.listeners)
      emitter.off(event, listener);
    this.clearScopes();
    await Promise.allSettled(
      [...this.snapshots].map((snapshot) => snapshot.close()),
    );
    await this.refreshPromise;
    await this.local.close();
  }
}
