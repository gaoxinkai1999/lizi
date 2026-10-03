const DB_NAME = "lizi-report-pages-v1";
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_PAGES = 48;
let database;
let generation = 0;
let warning = "";

export function cacheWarning(
  message = "浏览器无法持久保存缓存；在线功能仍可使用，离线重开可能不可用。",
) {
  warning = message;
  window.dispatchEvent(
    new CustomEvent("lizi:cache-warning", { detail: message }),
  );
}
export function getCacheWarning() {
  return warning;
}
function openDatabase() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error("缓存数据库响应超时"));
      }, 2500);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("pages", { keyPath: "key" });
        request.result.createObjectStore("session");
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          database = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        expired = true;
        reject(new Error("缓存数据库被其他标签页占用"));
      };
    }).catch((error) => {
      database = null;
      throw error;
    });
  return database;
}
function result(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        request.transaction?.abort();
      } catch {
        /* It may already have settled. */
      }
      reject(new Error("缓存读取超时"));
    }, 3000);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}
function completed(transaction) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        transaction.abort();
      } catch {
        /* It may already have settled. */
      }
      reject(new Error("缓存保存超时"));
    }, 5000);
    transaction.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    transaction.onerror = () => {
      clearTimeout(timer);
      reject(transaction.error);
    };
    transaction.onabort = () => {
      clearTimeout(timer);
      reject(transaction.error || new Error("缓存操作中止"));
    };
  });
}
async function safely(action, fallback = null) {
  try {
    return await action();
  } catch {
    cacheWarning();
    return fallback;
  }
}
export function readSession() {
  return safely(async () =>
    result(
      (await openDatabase())
        .transaction("session")
        .objectStore("session")
        .get("current"),
    ),
  );
}
export async function sessionScope(state) {
  if (state.authenticationEnabled && !state.user) return "";
  const identity = JSON.stringify([
    state.authenticationEnabled,
    state.deploymentMode || "client",
    state.user?.id,
    state.user?.role,
    state.dataRoot,
    state.dataScope,
    Boolean(state.transientReports),
  ]);
  if (!crypto.subtle) {
    cacheWarning(
      "此访问地址不支持安全的离线存储；在线功能不受影响。请使用 HTTPS 或本机地址启用离线功能。",
    );
    return "";
  }
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function saveSession(session) {
  const current = generation;
  return safely(async () => {
    const db = await openDatabase();
    if (current !== generation) return;
    const transaction = db.transaction("session", "readwrite");
    const done = completed(transaction);
    done.catch(() => {});
    const store = transaction.objectStore("session");
    const previous = await result(store.get("current"));
    if (current !== generation) {
      await done;
      return;
    }
    store.put(
      {
        ...session,
        query:
          previous?.scope === session.scope
            ? previous.query || session.query
            : session.query,
      },
      "current",
    );
    await done;
  });
}
export async function clearReportCache(broadcast = true) {
  generation++;
  await safely(async () => {
    const transaction = (await openDatabase()).transaction(
      ["pages", "session"],
      "readwrite",
    );
    const done = completed(transaction);
    transaction.objectStore("pages").clear();
    transaction.objectStore("session").clear();
    await done;
  });
  if (broadcast) {
    const value = `${Date.now()}-${Math.random()}`;
    channel?.postMessage(value);
    try {
      localStorage.setItem("lizi-cache-invalidation", value);
    } catch {
      /* BroadcastChannel remains available where supported. */
    }
  }
}
let lastInvalidation;
function invalidated(value) {
  if (value === lastInvalidation) return;
  lastInvalidation = value;
  generation++;
  window.dispatchEvent(new Event("lizi:cache-invalidated"));
}
let channel;
try {
  if (typeof BroadcastChannel === "function")
    channel = new BroadcastChannel("lizi-cache");
} catch {
  /* Storage events still synchronize tabs where channels are unavailable. */
}
if (channel) channel.onmessage = (event) => invalidated(event.data);
window.addEventListener("storage", (event) => {
  if (event.key === "lizi-cache-invalidation") invalidated(event.newValue);
});
export function pageKey(query) {
  return JSON.stringify([
    query.date,
    query.shift,
    Boolean(query.excludeAggregate),
    query.page || 1,
    query.pageSize || 100,
  ]);
}
export function readReportPage(scope, query) {
  if (!scope) return Promise.resolve(null);
  return safely(async () => {
    const transaction = (await openDatabase()).transaction([
      "session",
      "pages",
    ]);
    const session = await result(
      transaction.objectStore("session").get("current"),
    );
    if (session?.scope !== scope) return null;
    return result(
      transaction.objectStore("pages").get(`${scope}:${pageKey(query)}`),
    );
  });
}
export function saveReportPage(scope, query, data) {
  if (!scope) return Promise.resolve();
  const current = generation;
  return safely(async () => {
    const bytes = new Blob([JSON.stringify(data)]).size;
    if (bytes > MAX_BYTES) {
      cacheWarning("此页报告超出离线缓存容量，仍可在线查看。");
      return;
    }
    const db = await openDatabase();
    if (current !== generation) return;
    const transaction = db.transaction(["session", "pages"], "readwrite");
    const done = completed(transaction);
    // Register a rejection handler before awaiting individual requests.
    done.catch(() => {});
    const session = await result(
      transaction.objectStore("session").get("current"),
    );
    if (session?.scope !== scope || current !== generation) {
      await done;
      return;
    }
    const store = transaction.objectStore("pages");
    const key = `${scope}:${pageKey(query)}`;
    const entries = [];
    await new Promise((resolve, reject) => {
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          resolve();
          return;
        }
        entries.push({
          key: row.key,
          bytes: row.value.bytes,
          savedAt: row.value.savedAt,
        });
        row.continue();
      };
    });
    const others = entries
      .filter((entry) => entry.key !== key)
      .sort((a, b) => a.savedAt - b.savedAt);
    let size = others.reduce((sum, entry) => sum + entry.bytes, bytes);
    while (others.length >= MAX_PAGES || size > MAX_BYTES) {
      const oldest = others.shift();
      if (!oldest) break;
      store.delete(oldest.key);
      size -= oldest.bytes;
    }
    store.put({ key, bytes, savedAt: Date.now(), data });
    transaction
      .objectStore("session")
      .put({ ...session, query: { ...query } }, "current");
    await done;
  });
}
