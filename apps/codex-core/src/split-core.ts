import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexAccountService, CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { CodexCoreOptions } from "./main.js";
import { readControlJson, startControlServer } from "./control-server.js";

/** Account/control owner. It has no child execution process and never stops one. */
export async function startSplitCodexCore(options: CodexCoreOptions) {
  if (!isAbsolute(options.appServerEndpoint!) || options.appServerEndpoint === options.endpoint) throw new Error("Invalid AppServer endpoint");
  if (!Number.isSafeInteger(options.proxyPort) || options.proxyPort! < 1 || options.proxyPort! > 65535) {
    throw new Error("Split Codex core requires a fixed proxy port");
  }
  const release = await acquireCodexWriter(options.dataDirectory, "accounts");
  let accounts: CodexAccountService | undefined;
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    let phase = "control";
    const startedAt = Date.now();
    const timer = setInterval(() => console.warn("[opencraft codex-core]", JSON.stringify({
      event: "shutdown-wait", phase, durationMs: Date.now() - startedAt,
    })), 15_000);
    timer.unref();
    try { await control?.close(); phase = "accounts"; await accounts?.close(); }
    finally { clearInterval(timer); release(); }
  })();
  try {
    const dataDirectory = await realpath(options.dataDirectory);
    accounts = await CodexAccountService.start(options);
    const runtime = new CodexCoreControlClient(options.appServerEndpoint!, options.authToken);
    control = await startControlServer(options.endpoint, options.authToken, async request => {
      if (request.method === "GET" && request.url?.split("?")[0] === "/generation-directory") {
        const query = new URL(request.url, "http://local.invalid");
        return { status: 200, value: await runtime.generationDirectory(query.searchParams.get("threadId") ?? undefined) };
      }
      if (request.method === "GET" && request.url === "/launch") {
        return { status: 200, value: { dataDirectory, launch: accounts!.launch() } };
      }
      if (request.method === "GET" && request.url === "/health") {
        const native = await runtime.appServerHealth();
        if (native.dataDirectory !== dataDirectory || native.proxyBaseUrl !== `http://127.0.0.1:${options.proxyPort}`) {
          throw new Error("AppServer identity mismatch");
        }
        return { status: 200, value: { ...native, pid: process.pid, appServerPid: native.appServerPid ?? native.pid } };
      }
      if (request.method === "POST" && request.url === "/generation-host") {
        try {
          const value = await readControlJson(request), params = value.params as Record<string, unknown>;
          if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid generation Host envelope");
          if (value.operation === "claim" && typeof params.instanceId === "string" && typeof params.routingEpoch === "string") {
            return { status: 200, value: await runtime.claimGenerationHost(params.instanceId, params.routingEpoch) };
          }
          if (value.operation === "state") return { status: 200, value: await runtime.publishGenerationHost(params as unknown as import("@opencraft/account-pool-host").CodexGenerationHostUsage) };
          throw new Error("Unknown generation Host operation");
        } catch { return { status: 503, value: { error: "Generation Host receipt unavailable" } }; }
      }
      if (request.method !== "POST" || request.url !== "/accounts") return { status: 404, value: { error: "Unknown operation" } };
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error("Account request too large");
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value?.method !== "string" || !value.method.startsWith("opencraft/codex/accounts/")
          || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new Error("Invalid account request");
        return { status: 200, value: await accounts!.request(value.method, value.params) };
      } catch { return { status: 400, value: { error: "Invalid Codex account operation" } }; }
    });
    // A listening account plane can bootstrap the runtime before health becomes ready.
    return { endpoint: options.endpoint, health: { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid,
      codexPid: 0, nativeSocket: join(dirname(options.appServerEndpoint!), "native.sock") }, close };
  } catch (error) { await close(); throw error; }
}
