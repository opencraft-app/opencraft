import { ACCOUNT_CORE_STATE_MAX_BYTES } from "../../../scripts/full-upgrade/account-core-limits.mjs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { accountFailureDiagnostic, acquireCodexWriter, CODEX_CORE_PROTOCOL_VERSION, CodexAccountService, CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { CodexCoreOptions } from "./main.js";
import { readControlJson, startControlServer } from "./control-server.js";
import { AccountCoreOwner, type AccountOwnerExpectation } from "./account-owner.js";

/** Account/control owner. It has no child execution process and never stops one. */
export async function startSplitCodexCore(options: CodexCoreOptions) {
  if (!isAbsolute(options.appServerEndpoint!) || options.appServerEndpoint === options.endpoint) throw new Error("Invalid AppServer endpoint");
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
    finally { clearInterval(timer); owner.closeStorage(); release(); }
  })();
  try {
    await owner.load();
    const dataDirectory = await realpath(options.dataDirectory);
    accounts = await CodexAccountService.start({ ...options, ownerHandoff: {
      admissionOpen: owner.isOpen, onUncertain: owner.uncertain, onAttemptDispatch: owner.dispatchAttempt,
      onAttemptTerminal: owner.terminalAttempt, onAttemptSettled: owner.settleAttempt, retained: owner.retained(),
    } });
    // Establish the stable Host token before a possible frozen cold successor.
    accounts.launch();
    const runtime = new CodexCoreControlClient(options.appServerEndpoint!, options.authToken);
    control = await startControlServer(options.endpoint, options.authToken, async request => {
      if (request.method === "GET" && request.url?.startsWith("/owner-handoff/history?")) {
        try {
          const params = new URL(request.url, "http://local.invalid").searchParams;
          return { status: 200, value: owner.historyPage({ count: Number(params.get("count")), sha256: params.get("sha256") ?? "" },
            Number(params.get("after") ?? 0), Number(params.get("maxBytes") ?? 32768)) };
        } catch { return { status: 409, value: { error: "Account history snapshot or cursor rejected", code: "history-snapshot-conflict" } }; }
      }
      if (request.method === "GET" && ["/owner-handoff", "/owner-handoff?summary=1"].includes(request.url ?? "")) {
        return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(request.url?.includes("summary=1")),
          proof: owner.inspect(accounts?.handoffObservation()), maintenance: { interrupting, interrupted: maintenanceInterrupted } } };
      }
      if (request.method === "POST" && request.url === "/owner-handoff") {
        try {
          const input = await readControlJson(request, ACCOUNT_CORE_STATE_MAX_BYTES);
          if (input.action === "renew-operator-lease") {
            owner.renewOperatorLease(input as unknown as AccountOwnerExpectation);
            // Renewal must neither wait for interruption nor replace the drain proof.
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(input.summary === true) } };
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
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(input.summary === true), proof: owner.issueDrainPermit(accounts.handoffObservation()) } };
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
            return { status: 200, value: { pid: process.pid, handoff: owner.snapshot(input.summary === true), proof: owner.issueDrainPermit(accounts?.handoffObservation()), ready } };
          });
        } catch (error) {
          // Only stable classifications leave this private endpoint. Never expose
          // raw filesystem/database/credential errors or process environment.
          const message = error instanceof Error ? error.message : "";
          const code = message.includes("launch") ? "launch-reference-conflict"
            : message.includes("storage") || message.includes("configuration") || message.includes("CLI") ? "readiness-storage-or-configuration"
            : message.includes("unknown") || message.includes("history") ? "historical-responsibility-conflict"
            : message.includes("proof") || message.includes("drained") ? "drain-proof-conflict"
            : message.includes("lease") ? "operator-lease-conflict"
            : message.includes("readiness") || message.includes("successor") ? "cold-readiness-conflict"
            : "owner-handoff-conflict";
          return { status: 409, value: { error: "Account Core handoff rejected", code } };
        }
      }
      if (request.method === "GET" && request.url?.split("?")[0] === "/generation-directory") {
        const query = new URL(request.url, "http://local.invalid");
        return { status: 200, value: await runtime.generationDirectory(query.searchParams.get("threadId") ?? undefined) };
      }
      if (request.method === "GET" && request.url === "/launch") {
        if (!accounts) return { status: 503, value: { error: "Account Core writer released" } };
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
      let leave;
      let method: string | null = null, accountId: string | null = null;
      let stage = "admission";
      const startedAt = Date.now();
      try {
        // Count the body read too. An already accepted mutation is not forgotten
        // when a caller disconnects or maintenance closes new admission.
        const acceptedOpen = owner.isOpen();
        leave = owner.enter(true);
        stage = "request-read";
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error("Account request too large");
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value?.method !== "string" || !value.method.startsWith("opencraft/codex/accounts/")
          || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new Error("Invalid account request");
        method = /^opencraft\/codex\/accounts\/[A-Za-z/]+$/u.test(value.method) && value.method.length <= 128 ? value.method : null;
        accountId = typeof value.params.accountId === "string" && /^[a-f0-9-]{36}$/u.test(value.params.accountId) ? value.params.accountId : null;
        if (!acceptedOpen && !["opencraft/codex/accounts/deviceLogin/cancel", "opencraft/codex/accounts/deviceLogin/poll"].includes(value.method)) {
          return { status: 503, value: { error: "Account Core admission is fenced" } };
        }
        stage = "account-operation";
        return { status: 200, value: await accounts!.request(value.method, value.params) };
      } catch (error) {
        console.warn("[opencraft codex-core]", JSON.stringify({ event: "account-operation-failed", method, accountId,
          stage, admissionOpen: owner.isOpen(), durationMs: Date.now() - startedAt, ...accountFailureDiagnostic(error) }));
        return { status: owner.isOpen() ? 400 : 503, value: { error: "Invalid or fenced Codex account operation" } };
      }
      finally { leave?.(); }
    });
    // A listening account plane can bootstrap the runtime before health becomes ready.
    return { endpoint: options.endpoint, health: { protocolVersion: CODEX_CORE_PROTOCOL_VERSION, pid: process.pid,
      codexPid: 0, nativeSocket: join(dirname(options.appServerEndpoint!), "native.sock") }, close };
  } catch (error) { await close(); throw error; }
}
