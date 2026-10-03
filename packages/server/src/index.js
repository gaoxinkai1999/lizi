import { createApplication } from "./app.js";

const runtime = await createApplication();
const host = process.env.LIZI_HOST ?? "127.0.0.1";
const server = runtime.app.listen(runtime.port, host, () => {
  console.log(`粒子报告${runtime.deploymentMode === "server" ? "服务器" : "客户端后台"}已启动 http://${host}:${runtime.port}`);
  console.log(`持久数据目录：${runtime.home}`);
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
runtime.ready.catch(async (error) => {
  console.error("报告服务初始化失败：", error);
  process.exitCode = 1;
  await shutdown();
});
server.on("error", async (error) => {
  console.error("后台监听失败：", error);
  await runtime.close();
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close();
  server.closeIdleConnections();
  await runtime.close();
  clearTimeout(deadline);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
