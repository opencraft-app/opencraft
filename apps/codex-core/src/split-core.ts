import { ACCOUNT_CORE_STATE_MAX_BYTES } from "./account-core-limits.mjs";
import { personalSubscriptionRoute, personalSubscriptionTarget } from "./personal-subscription-route.js";
import { realpath } from "node:fs/promises";
import { Readable } from 'node:stream';
import { dirname, isAbsolute, join } from "node:path";
import { accountFailure, classifyAccountFailure, logAccountFailure, acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexAccountService, CodexCoreControlClient, codexNativeSocket } from "@opencraft/account-pool-host";
import type { CodexCoreOptions } from "./main.js";
import { readControlJson, startControlServer } from "./control-server.js";
import { AccountCoreOwner, type AccountOwnerExpectation } from "./account-owner.js";

/** Account/control owner. It has no child execution process and never stops one. */
export async function startSplitCodexCore(options: CodexCoreOptions) {
  if (options.accountsOnly ? options.appServerEndpoint !== undefined
    : !isAbsolute(options.appServerEndpoint!) || options.appServerEndpoint === options.endpoint) throw new Error("Invalid AppServer endpoint");
  if (!Number.isSafeInteger(options.proxyPort) || options.proxyPort! < 1 || options.proxyPort! > 65535) {
    throw new Error("Split Codex core requires a fixed proxy port");
  }
  const release = await acquireCodexWriter(options.dataDirectory, "accounts");
  const owner = new AccountCoreOwner(options);
  let accounts: CodexAccountService | undefined;
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let closing: Promise<void> | undefined;
  let interrupting = false, maintenanceInterrupted = false;
  const close = () => closing ??= (async () => {
    let phase = "control";
    const startedAt = Date.now();
    const timer = setInterval(() => console.warn("[opencraft codex-core]", JSON.stringify({
      event: "shutdown-wait", phase, durationMs: Date.now() - startedAt,
    })), 15_000);
    timer.unref();
    owner.dispose();
    try { await control?.close(); phase = "accounts"; await accounts?.close(); }
    finally { clearInterval(timer); release(); }
  })();
  try {
    await owner.load();
    const dataDirectory = await realpath(options.dataDirectory);
    accounts = await CodexAccountService.start({ ...options, ownerHandoff: {
      admissionOpen: owner.isOpen, onUncertain: owner.uncertain, retained: owner.retained(),
    } });
    // Establish the stable Host token before a possible frozen cold successor.
    accounts.launch();
    // Accounts-only: the runtime owner's health belongs to its WorkspaceHost, not to this Core.
    const runtime = options.appServerEndpoint ? new CodexCoreControlClient(options.appServerEndpoint, options.authToken) : null;
    control = await startControlServer(options.endpoint, options.authToken, async request => {
      if (request.method === "GET" && request.url === "/owner-handoff") {
        return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(),
          proof: owner.inspect(accounts?.handoffObservation()), maintenance: { interrupting, interrupted: maintenanceInterrupted } } };
      }
      if (request.method === "POST" && request.url === "/owner-handoff") {
        try {
          const input = await readControlJson(request, ACCOUNT_CORE_STATE_MAX_BYTES);
          if (input.action === "renew-operator-lease") {
            owner.renewOperatorLease(input as unknown as AccountOwnerExpectation);
            // Renewal must neither wait for interruption nor replace the drain proof.
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot() } };
          }
          if (interrupting) throw new Error("Account maintenance interruption is running");
          if (input.action === "maintenance-interrupt") {
            // Do not hold owner.transition while waiting: onUncertain must use
            // that same queue to durably account for interrupted requests.
            await owner.transition(async () => owner.checkMaintenance(input as unknown as AccountOwnerExpectation));
            if (!accounts) throw new Error("Account writer already released");
            interrupting = true;
            try { await accounts.interruptForMaintenance(); maintenanceInterrupted = true; }
            finally { interrupting = false; }
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(), proof: owner.inspect(accounts.handoffObservation()) } };
          }
          return await owner.transition(async () => {
            const expected = input as unknown as AccountOwnerExpectation;
            let ready;
            switch (input.action) {
              case "fence": await owner.fence(expected); maintenanceInterrupted = false; break;
              case "abort": await owner.abortFence(expected); maintenanceInterrupted = false; break;
              case "inspect": owner.checkInspection(expected); break;
              case "maintenance-accept-unknown":
                if (!maintenanceInterrupted || !accounts) throw new Error("Account maintenance interruption is unconfirmed");
                await owner.acceptMaintenanceUnknown(expected, accounts.handoffObservation().activeCount); break;
              case "release":
                if (!accounts) throw new Error("Account writer already released");
                await owner.release(expected, accounts.handoffObservation(), () => accounts!.retainedState(), async () => {
                  await accounts!.close(); accounts = undefined;
                }); break;
              case "cold-ready": ready = await owner.coldReady(expected); break;
              case "resume": await owner.resume(expected, () => accounts!.activate()); break;
              default: throw new Error("Unknown account handoff action");
            }
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(), proof: owner.inspect(accounts?.handoffObservation()), ready } };
          });
        } catch { return { status: 409, value: { error: "Account Core handoff rejected" } }; }
      }
      const personalRoute=personalSubscriptionRoute(request.url);
      if(personalRoute) {
        if(!owner.isOpen()||!accounts)return new Response(null,{status:503});
        const headers=new Headers();
        headers.set('authorization','Bearer '+String(request.headers['x-opencraft-subscription-token']??''));
        if(request.headers['content-type'])headers.set('content-type',request.headers['content-type']);
        return fetch(personalSubscriptionTarget(`http://127.0.0.1:${options.proxyPort}`,personalRoute),{method:request.method,headers,
          ...(request.method==='GET'?{}:{body:Readable.toWeb(request),duplex:'half'})} as RequestInit);
      }
      if (request.method === "GET" && request.url === "/launch") {
        if (!accounts) return { status: 503, value: { error: "Account Core writer released" } };
        return { status: 200, value: { dataDirectory, launch: accounts!.launch() } };
      }
      if (request.method === "GET" && (request.url === "/health" || request.url === "/native-health")) {
        if (!runtime) return { status: 404, value: { error: "This account Core has no runtime owner" } };
        const native = await runtime.appServerHealth(request.url === "/native-health" ? "native" : "execution");
        if (native.dataDirectory !== dataDirectory || native.proxyBaseUrl !== `http://127.0.0.1:${options.proxyPort}`) {
          throw new Error("AppServer identity mismatch");
        }
        return { status: 200, value: { ...native, pid: process.pid, appServerPid: native.appServerPid ?? native.pid } };
      }
      if (request.method !== "POST" || request.url !== "/accounts") return { status: 404, value: { error: "Unknown operation" } };
      let leave;
      let operation: string | undefined;
      const startedAt = Date.now();
      const acceptedOpen = owner.isOpen();
      try {
        // Count the body read too. An already accepted mutation is not forgotten
        // when a caller disconnects or maintenance closes new admission.
        leave = owner.enter(true);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) throw accountFailure("invalid-request", "operation", false);
          chunks.push(chunk);
        }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw accountFailure("invalid-request", "operation", false); }
        if (typeof value?.method !== "string" || !value.method.startsWith("opencraft/codex/accounts/")
          || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw accountFailure("invalid-request", "operation", false);
        operation = value.method;
        if (!acceptedOpen && !["opencraft/codex/accounts/deviceLogin/cancel", "opencraft/codex/accounts/deviceLogin/poll"].includes(value.method)) {
          throw accountFailure("admission-fenced", "operation", true);
        }
        return { status: 200, value: await accounts!.request(value.method, value.params) };
      } catch (error) {
        const failure = acceptedOpen ? classifyAccountFailure(error, "operation") : accountFailure("admission-fenced", "operation", true);
        logAccountFailure(failure, { operation, durationMs: Date.now() - startedAt });
        const code = failure.diagnostic.code;
        const status = code === "invalid-request" ? 400 : code === "admission-fenced" || code === "service-unavailable" ? 503
          : code === "request-timeout" ? 504 : 502;
        return { status, value: { error: failure.message, diagnostic: failure.diagnostic } };
      }
      finally { leave?.(); }
    });
    // A listening account plane can bootstrap the runtime before health becomes ready.
    return { endpoint: options.endpoint, health: { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid,
      codexPid: 0, nativeSocket: options.appServerEndpoint ? codexNativeSocket(options.appServerEndpoint) : "" }, close };
  } catch (error) { await close(); throw error; }
}
