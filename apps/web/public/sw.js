const VERSION = `lizi-shell-${new URL(self.location.href).searchParams.get("build") || "v1"}`;
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const HASHED_ASSET =
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp|ico)$/;
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const response = await fetch("/", {
        cache: "reload",
        credentials: "omit",
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/html")
      )
        throw new Error("应用壳下载失败");
      const html = await response.clone().text();
      const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((match) => new URL(match[1], self.location.origin))
        .filter(
          (url) =>
            url.origin === self.location.origin &&
            HASHED_ASSET.test(url.pathname),
        );
      const assets = await caches.open(ASSETS);
      await Promise.all(
        urls.map(async (url) => {
          const asset = await fetch(url, {
            cache: "reload",
            credentials: "omit",
          });
          if (!asset.ok) throw new Error("应用资源下载失败");
          await assets.put(url, asset);
        }),
      );
      await cache.put("/", response);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("lizi-shell-") && ![SHELL, ASSETS].includes(name))
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api")
  )
    return;
  if (request.mode === "navigate") {
    // The shell has no session/configuration data. State is always revalidated by the app.
    event.respondWith(
      (async () => {
        const cached = await (await caches.open(SHELL)).match("/");
        return cached || fetch(request);
      })(),
    );
    event.waitUntil(
      (async () => {
        try {
          const response = await fetch("/", {
            cache: "no-store",
            credentials: "omit",
          });
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("text/html")
          )
            return;
          const html = await response.clone().text();
          const cache = await caches.open(SHELL);
          const previous = await cache.match("/");
          if (previous && (await previous.text()) === html) return;
          const assets = await caches.open(ASSETS);
          const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
            .map((match) => new URL(match[1], self.location.origin))
            .filter(
              (asset) =>
                asset.origin === self.location.origin &&
                HASHED_ASSET.test(asset.pathname),
            );
          await Promise.all(
            urls.map(async (asset) => {
              const value = await fetch(asset, { credentials: "omit" });
              if (!value.ok) throw new Error("应用资源下载失败");
              await assets.put(asset, value);
            }),
          );
          await cache.put("/", response);
          for (const client of await self.clients.matchAll())
            client.postMessage({ type: "lizi-shell-update" });
        } catch {
          /* Keep the complete previous shell while offline. */
        }
      })(),
    );
  } else if (HASHED_ASSET.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
