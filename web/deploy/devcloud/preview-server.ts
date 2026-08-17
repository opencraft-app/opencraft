import {resolve, sep} from "node:path";

const options = parseOptions(Bun.argv.slice(2));
const root = resolve(options.root);
const indexFile = Bun.file(resolve(root, "index.html"));

if (!(await indexFile.exists())) {
  throw new Error(`预览入口不存在：${resolve(root, "index.html")}`);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: options.port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {status: 405});
    }
    const url = new URL(request.url);
    if (url.pathname === "/healthz-web") {
      return new Response("ok\n", {
        headers: {"Cache-Control": "no-store", "Content-Type": "text/plain"},
      });
    }
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      return new Response("本地静态预览不代理 DevCloud API。\n", {status: 502});
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request\n", {status: 400});
    }
    const requested = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
      return new Response("Forbidden\n", {status: 403});
    }
    const file = Bun.file(requested);
    if (await file.exists()) {
      return staticResponse(file, pathname);
    }
    if (immutableAssetPath(pathname)) {
      return new Response("Not Found\n", {
        headers: {"Cache-Control": "no-store"},
        status: 404,
      });
    }
    return staticResponse(indexFile, "/index.html");
  },
});

console.log(`Vela Web 本地预览：http://${server.hostname}:${server.port}/`);

function staticResponse(file: Blob, pathname: string): Response {
  const immutable = immutableAssetPath(pathname);
  return new Response(file, {
    headers: {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

function immutableAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_expo/static/") ||
    pathname.startsWith("/assets/");
}

function parseOptions(args: string[]): {port: number; root: string} {
  let port = 63886;
  let root = "web/apps/client/dist";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
        throw new Error("--port 必须是 1-65535 的整数");
      }
      port = value;
      index += 1;
      continue;
    }
    if (argument === "--root") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--root 缺少值");
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return {port, root};
}
