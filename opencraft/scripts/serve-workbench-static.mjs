import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error("Request body exceeds the runtime report limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function resolveRequestPath(staticRoot, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = resolve(staticRoot, relativePath || "index.html");
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${sep}`)) return null;
  return candidate;
}

function isContentHashedAsset(pathname) {
  return /^\/assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u.test(pathname);
}

function isWorkbenchApplicationRoute(pathname) {
  return /^\/(?:local|settings|threads|views)\/[^/]+\/?$/u.test(pathname);
}

async function serveFile(request, response, path, pathname) {
  const metadata = await stat(path);
  if (!metadata.isFile()) return false;
  response.statusCode = 200;
  response.setHeader("content-length", metadata.size);
  response.setHeader("content-type", contentTypes.get(extname(path).toLowerCase()) || "application/octet-stream");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("etag", `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`);
  if (pathname === "/" || pathname === "/index.html" || pathname === "/version.json") {
    response.setHeader("cache-control", "no-store, max-age=0");
  } else if (isContentHashedAsset(pathname)) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else {
    response.setHeader("cache-control", "no-cache");
  }
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
  return true;
}

/** Electron-only static origin. This module intentionally has no proxy API. */
export async function createWorkbenchStaticServer({ root }) {
  const staticRoot = await realpath(resolve(root));
  const runtimeReports = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://vela.invalid");
      if (url.pathname === "/__opencraft_health") {
        sendJson(response, 200, { ok: true, staticRoot });
        return;
      }
      if (url.pathname === "/__opencraft_runtime_error") {
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "POST required" });
          return;
        }
        const report = await readJsonBody(request);
        runtimeReports.push({ receivedAt: new Date().toISOString(), report });
        runtimeReports.splice(0, Math.max(0, runtimeReports.length - 20));
        console.error("[opencraft runtime error]", report);
        sendJson(response, 202, { ok: true });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "GET or HEAD required" });
        return;
      }
      if (url.pathname.endsWith(".map")) {
        sendJson(response, 404, { ok: false, error: "Source maps are not public" });
        return;
      }
      const requestedPath = resolveRequestPath(staticRoot, url.pathname);
      if (requestedPath === null) {
        sendJson(response, 400, { ok: false, error: "Invalid path" });
        return;
      }
      try {
        if (await serveFile(request, response, requestedPath, url.pathname)) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const acceptsHtml = (request.headers.accept || "").includes("text/html");
      if (acceptsHtml && (extname(url.pathname) === "" || isWorkbenchApplicationRoute(url.pathname))) {
        await serveFile(request, response, join(staticRoot, "index.html"), "/index.html");
        return;
      }
      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error("[opencraft static server]", error);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Internal server error" });
      else response.destroy(error);
    }
  });
  return {
    server,
    staticRoot,
    listen({ host = "127.0.0.1", port = 0 } = {}) {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolvePromise(server.address());
        });
      });
    },
    close() {
      return new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
}
