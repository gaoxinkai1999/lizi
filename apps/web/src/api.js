export async function request(
  path,
  { method = "GET", body, signal, binary = false } = {},
) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Lizi-Request": "1",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    const sessionExpired =
      response.status === 401 &&
      !["/auth/login", "/auth/setup", "/auth/state"].includes(path);
    const accessChanged =
      response.status === 409 &&
      (path.startsWith("/auth/") || path.startsWith("/users"));
    if (sessionExpired || accessChanged)
      window.dispatchEvent(new Event("lizi:unauthorized"));
    throw error;
  }
  if (binary) return response;
  return response.status === 204 ? null : response.json();
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
