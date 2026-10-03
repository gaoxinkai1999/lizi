let writesAllowed = false;
export function setWritesAllowed(value) {
  writesAllowed = value;
}

export async function request(
  path,
  {
    method = "GET",
    body,
    signal,
    binary = false,
    timeout = binary ? 180_000 : 45_000,
    retries = method === "GET" ? 1 : 0,
    localAdmin = false,
  } = {},
) {
  if (navigator.onLine === false || (method !== "GET" && !writesAllowed))
    throw new Error("当前离线或身份尚未重新验证，不能提交操作。请联网后重试。");
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    try {
      const headers = {
        "X-Lizi-Request": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      };
      if (localAdmin && window.liziDesktop?.getLocalAdminToken) {
        const token = await window.liziDesktop.getLocalAdminToken();
        if (token) headers["X-Lizi-Local-Admin"] = token;
      }
      const response = await fetch(`/api${path}`, {
        method,
        credentials: "same-origin",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const error = new Error(
          payload?.error || `请求失败（${response.status}）`,
        );
        error.status = response.status;
        const sessionExpired =
          response.status === 401 &&
          !["/auth/login", "/auth/setup", "/auth/state"].includes(path);
        if (sessionExpired) {
          writesAllowed = false;
          window.dispatchEvent(new Event("lizi:unauthorized"));
        }
        throw error;
      }
      if (binary) {
        const blob = await response.blob();
        return { headers: response.headers, blob: async () => blob };
      }
      return response.status === 204 ? null : await response.json();
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const retryable =
        method === "GET" &&
        (!cause.status || [408, 429, 502, 503, 504].includes(cause.status));
      if (!retryable || attempt >= retries || navigator.onLine === false) {
        if (!cause.status)
          window.dispatchEvent(new Event("lizi:network-failure"));
        if (timedOut)
          throw new Error(
            method === "GET"
              ? "请求超时，已保留现有报告，请稍后重试。"
              : "请求超时，操作结果尚未确认；请先刷新状态，不要重复提交。",
          );
        if (!cause.status && method !== "GET")
          throw new Error(
            "网络中断，操作结果尚未确认。请联网后先刷新状态，不要重复提交。",
          );
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        1200 * 2 ** attempt + Math.random() * 400,
      );
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export function showValue(value) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
