// Tencent Cloud COS helper used by the maintainer-side release tooling.
//
// Only the publishing script talks to COS: the running center stores and serves
// the download URL and never contacts object storage. Credentials come from
// TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY (the Tencent Cloud SDK
// convention) and are never written into the repository or any config file.
//
// The signature implementation mirrors cos-nodejs-sdk-v5 exactly (SHA1 variant):
// signKey = HMAC-SHA1(SecretKey, keyTime) as a lowercase hex string, then
// signature = HMAC-SHA1(signKey, stringToSign) hex.
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import https from "node:https";

const COS_PORT = 443;
const DEFAULT_REGION = "ap-beijing";

// COS encodes header and parameter names/values with encodeURIComponent plus a
// few extra escapes.
function camSafeUrlEncode(value) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function hmacSha1(key, value) {
  return createHmac("sha1", key).update(value).digest();
}

// Sorted, lower-cased, camSafe-encoded "k=v" list used for both headers and
// query parameters inside the format string.
function canonicalPairs(source, { lowercaseKeys }) {
  return Object.keys(source)
    .map((name) => [name, source[name]])
    .sort(([left], [right]) => {
      const a = left.toLowerCase();
      const b = right.toLowerCase();
      return a === b ? 0 : a > b ? 1 : -1;
    })
    .map(([name, value]) => {
      const raw = value === undefined || value === null ? "" : String(value);
      const encodedName = camSafeUrlEncode(name);
      return `${lowercaseKeys ? encodedName.toLowerCase() : encodedName}=${camSafeUrlEncode(raw) || ""}`;
    })
    .join("&");
}

function listNames(pairs) {
  return pairs
    .split("&")
    .filter(Boolean)
    .map((pair) => pair.slice(0, pair.indexOf("=")))
    .join(";");
}

export function cosEndpoint(bucket, region = DEFAULT_REGION) {
  return `${bucket}.cos.${region}.myqcloud.com`;
}

export function cosServiceEndpoint(region = DEFAULT_REGION) {
  return `cos.${region}.myqcloud.com`;
}

export function cosObjectUrl(bucket, region, key) {
  const encoded = key
    .split("/")
    .map((segment) => camSafeUrlEncode(segment))
    .join("/");
  return `https://${cosEndpoint(bucket, region)}/${encoded}`;
}

export function createCosCredentials() {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey)
    throw new Error(
      "缺少 COS 凭据：请设置 TENCENTCLOUD_SECRET_ID 与 TENCENTCLOUD_SECRET_KEY",
    );
  return {
    secretId,
    secretKey,
    region: process.env.TENCENTCLOUD_REGION ?? DEFAULT_REGION,
  };
}

export function cosAuthorization({
  secretId,
  secretKey,
  method,
  path,
  query = {},
  headers = {},
  start,
  end,
}) {
  const signTime = `${start};${end}`;
  const keyTime = signTime;
  const headerPairs = canonicalPairs(headers, { lowercaseKeys: true });
  const paramPairs = canonicalPairs(query, { lowercaseKeys: true });
  const formatString = [
    method.toLowerCase(),
    path,
    paramPairs,
    headerPairs,
    "",
  ].join("\n");
  const stringToSign = [
    "sha1",
    signTime,
    sha1(Buffer.from(formatString, "utf8")),
    "",
  ].join("\n");
  const signKey = hmacSha1(secretKey, keyTime).toString("hex");
  const signature = hmacSha1(signKey, stringToSign).toString("hex");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${listNames(headerPairs)}`,
    `q-url-param-list=${listNames(paramPairs)}`,
    `q-signature=${signature}`,
  ].join("&");
}

// Single signed COS request. `body` is an optional readable stream (uploads).
export function cosRequest({
  secretId,
  secretKey,
  method,
  host,
  path,
  query = {},
  headers = {},
  body,
  lifetimeSeconds = 900,
}) {
  const now = Math.floor(Date.now() / 1000);
  const signedHeaders = { host, ...headers };
  const authorization = cosAuthorization({
    secretId,
    secretKey,
    method,
    path,
    query,
    headers: signedHeaders,
    start: now - 60,
    end: now + lifetimeSeconds,
  });
  const search = Object.entries(query)
    .map(
      ([key, value]) =>
        `${camSafeUrlEncode(key)}=${camSafeUrlEncode(String(value))}`,
    )
    .join("&");
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method,
        host,
        port: COS_PORT,
        path: search ? `${path}?${search}` : path,
        headers: { ...signedHeaders, Authorization: authorization },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body) body.pipe(request);
    else request.end();
  });
}

export function createCosClient(options = {}) {
  const credentials = options.secretId
    ? {
        secretId: options.secretId,
        secretKey: options.secretKey,
        region: options.region ?? DEFAULT_REGION,
      }
    : createCosCredentials();
  const { secretId, secretKey } = credentials;
  const region = options.region ?? credentials.region;
  const bucket = options.bucket;
  if (!bucket) throw new Error("缺少存储桶名称");
  const host = cosEndpoint(bucket, region);

  return {
    bucket,
    region,
    host,
    endpoint: host,
    objectUrl: (key) => cosObjectUrl(bucket, region, key),
    request: (args) =>
      cosRequest({ secretId, secretKey, host, ...args }),
    uploadFile: (key, file, { size, contentType = "application/octet-stream" }) =>
      cosRequest({
        secretId,
        secretKey,
        method: "PUT",
        host,
        path: `/${key}`,
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          // Object-level public read keeps anonymous installer downloads
          // working without signing every URL; the bucket itself stays
          // unlistable because only object ACLs are public.
          "x-cos-acl": "public-read",
        },
        body: createReadStream(file),
      }),
    headObject: (key) =>
      cosRequest({ secretId, secretKey, method: "HEAD", host, path: `/${key}` }),
    deleteObject: (key) =>
      cosRequest({ secretId, secretKey, method: "DELETE", host, path: `/${key}` }),
  };
}

export async function listBuckets({ secretId, secretKey, region = DEFAULT_REGION } = {}) {
  const host = cosServiceEndpoint(region);
  const response = await cosRequest({
    secretId,
    secretKey,
    method: "GET",
    host,
    path: "/",
  });
  return { status: response.status, body: response.body.toString("utf8") };
}

export async function createBucket({
  secretId,
  secretKey,
  region = DEFAULT_REGION,
  bucket,
  acl = "private",
}) {
  const response = await cosRequest({
    secretId,
    secretKey,
    method: "PUT",
    host: cosServiceEndpoint(region),
    path: "/",
    headers: { "x-cos-acl": acl },
    query: { bucketName: bucket },
  });
  return { status: response.status, body: response.body.toString("utf8") };
}

export function describeCosError(response) {
  const text = response.body?.toString?.("utf8") ?? "";
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  if (code || message)
    return `HTTP ${response.status} ${[code, message].filter(Boolean).join(" ")}`;
  return `HTTP ${response.status} ${text.slice(0, 200)}`;
}
