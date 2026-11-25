import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCodexAccountPoolLaunch } from "@opencraft/account-pool-host";
import { startControlServer } from "../../apps/codex-core/src/control-server.ts";

const nativeRoutes = new Map([
  ["GET /v1/models", "models"],
  ["POST /v1/responses", "responses"],
]);
const reply = (response, status) => response.writeHead(status, { "cache-control": "no-store" }).end();
const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });

/**
 * The workspace has no account Core or provider key. This private facade
 * supplies the stock AppServer with a local launch and a loopback-only synthetic
 * login. The container's network intercept grants egress independently.
 */
export async function startWorkspaceCodexModelRelay({
  target,
  dataDirectory,
  controlEndpoint,
  controlToken,
  fetchModel = fetch,
}) {
  const localToken = randomBytes(32).toString("base64url");
  const modelAccess = { token: null };
  const model = createServer(async (request, response) => {
    if (!request.url?.startsWith("/v1/")) return reply(response, 404);
    if (modelAccess.token === null) return reply(response, 503);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = nativeRoutes.get(`${request.method} ${url.pathname}`);
    if (!route) return reply(response, 404);
    if (
      request.headers["x-opencraft-account-pool-token"] !== localToken &&
      request.headers.authorization !== `Bearer ${modelAccess.token}`
    )
      return reply(response, 401);
    const headers = new Headers();
    for (const name of ["accept", "content-type", "content-encoding"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    try {
      const destination = new URL(route, target);
      // Native attaches its catalog client version; upstream receives only the
      // catalog route and that public compatibility hint.
      const version = url.searchParams.get("client_version");
      if (route === "models" && version && /^[0-9A-Za-z.-]{1,80}$/u.test(version))
        destination.searchParams.set("client_version", version);
      const result = await fetchModel(
        new Request(destination, {
          method: request.method,
          headers,
          ...(route === "responses" ? { body: Readable.toWeb(request), duplex: "half" } : {}),
          redirect: "manual",
          signal: abort.signal,
        }),
      );
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel();
        return reply(response, 502);
      }
      const outgoing = {};
      for (const name of ["content-type", "retry-after", "x-request-id"]) {
        const value = result.headers.get(name);
        if (value !== null) outgoing[name] = value;
      }
      response.writeHead(result.status, outgoing);
      if (result.body) await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
    } catch {
      if (response.headersSent || abort.signal.aborted) response.destroy();
      else reply(response, 502);
    }
  });
  await new Promise((resolve, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", () => {
      model.off("error", reject);
      resolve();
    });
  });
  const launch = createCodexAccountPoolLaunch({
    baseUrl: `http://127.0.0.1:${model.address().port}`,
    hostToken: localToken,
  });
  modelAccess.token = launch.auth.accessToken;
  let control;
  try {
    control = await startControlServer(controlEndpoint, controlToken, async (request) =>
      request.method === "GET" && request.url === "/launch"
        ? { status: 200, value: { dataDirectory, launch } }
        : { status: 404, value: { error: "missing" } },
    );
  } catch (error) {
    await closeServer(model).catch(() => {});
    throw error;
  }
  return {
    async close() {
      try {
        await control.close();
      } finally {
        await closeServer(model);
      }
    },
  };
}
