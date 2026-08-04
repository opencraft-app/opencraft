const routePaths = [
  "/join",
  "/s/atlas",
  "/s/atlas/c/channel-1",
  "/s/atlas/tasks",
  "/s/atlas/agents",
  "/s/atlas/computers",
  "/s/atlas/computers/computer-1",
  "/s/atlas/members",
  "/s/atlas/dm/019fb723-68b8-79ac-b31e-9d0a657c43ec",
  "/s/atlas/dm/new?peerMemberId=019fb723-68b8-79ac-b31e-9d0a657c43ed",
];

const remoteOrigin = process.env.RAFT_WEB_VERIFY_ORIGIN?.replace(/\/$/u, "");

if (remoteOrigin) {
  for (const path of routePaths) {
    const response = await fetch(`${remoteOrigin}${path}`, {
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !contentType.includes("text/html")) {
      throw new Error(
        `${path} 未回退到 SPA HTML：status=${response.status}, content-type=${contentType}`,
      );
    }
  }
  console.log(`已验证 ${routePaths.length} 个线上 SPA 深链接。`);
  process.exit(0);
}

const indexFile = Bun.file(new URL("../dist/index.html", import.meta.url));
if (!(await indexFile.exists())) {
  throw new Error("缺少 dist/index.html；请先执行 bun run build:web");
}
const indexHtml = await indexFile.text();
if (!indexHtml.includes("<html") && !indexHtml.includes("<!DOCTYPE html")) {
  throw new Error("dist/index.html 不是有效的 HTML 入口");
}

const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(indexHtml, {
      headers: {"content-type": "text/html; charset=utf-8"},
      status: 200,
    }),
});

try {
  for (const path of routePaths) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
    if (response.status !== 200 || (await response.text()) !== indexHtml) {
      throw new Error(`${path} 未返回同一个 SPA 入口`);
    }
  }
  console.log(`已验证 ${routePaths.length} 个本地 SPA 深链接。`);
} finally {
  server.stop(true);
}
