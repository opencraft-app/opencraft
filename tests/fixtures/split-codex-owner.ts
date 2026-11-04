// Isolated drill child entry. Configuration contains synthetic data only.
import { readFile } from "node:fs/promises";
import { startCodexCore } from "../../apps/codex-core/src/main.js";
import { AccountCoreOwner, sealLegacyAccountMaintenance } from "../../apps/codex-core/src/account-owner.js";
import { startCodexAppServer } from "../../apps/codex-core/src/app-server.js";

const options = JSON.parse(await readFile(process.argv[3]!, "utf8"));
if (process.argv[2] === "maintenance-inspect") {
  console.log(JSON.stringify(await new AccountCoreOwner(options).inspectMaintenance()));
} else if (process.argv[2] === "maintenance-preview-exported") {
  console.log(JSON.stringify(await new AccountCoreOwner(options).inspectExportedMaintenance(process.argv[4]!)));
} else if (process.argv[2] === "maintenance-seal-exported") {
  const { sealExportedAccountMaintenance } = await import("../../apps/codex-core/src/account-owner.js");
  console.log(JSON.stringify(await sealExportedAccountMaintenance(options, process.argv[4]!)));
} else if (process.argv[2] === "maintenance-seal-fenced") {
  const { sealFencedAccountMaintenance } = await import("../../apps/codex-core/src/account-owner.js");
  console.log(JSON.stringify(await sealFencedAccountMaintenance(options, process.argv[4]!)));
} else if (process.argv[2] === "maintenance-seal") {
  console.log(JSON.stringify(await sealLegacyAccountMaintenance(options, process.argv[4]!)));
} else {
let shutdown: ((code: number) => Promise<void>) | undefined;
const onFailure = () => void shutdown?.(1);
const service = process.argv[2] === "runtime" ? await startCodexAppServer({ ...options, onFailure })
  : await startCodexCore({ ...options, onFailure,
    createMaintenanceClient: options.syntheticMaintenance ? async () => ({
      request: async (method: string) => method === "account/login/start"
        ? { type: "chatgptDeviceCode", loginId: "synthetic-login", verificationUrl: "https://example.invalid", userCode: "SYNTHETIC" } : {},
      subscribeNotification: () => () => {}, close: async () => {},
    }) as import("@opencraft/account-pool-host").CodexMaintenanceClient : undefined,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    // Both quota maintenance and inference stay on the local fixture server.
    const target = raw.includes("/wham/usage") ? `${options.upstreamBaseUrl}/usage`
      : raw.includes("/wham/rate-limit-reset-credits") ? `${options.upstreamBaseUrl}/reset-credits${raw.endsWith("/consume") ? "/consume" : ""}` : raw;
    if (new URL(target).hostname !== "127.0.0.1") throw new Error("Non-local model request in isolated drill");
    return fetch(target, init);
  } });
shutdown = async code => { await service.close(); process.exit(code); };
process.on("SIGTERM", () => void shutdown!(0));
process.on("SIGINT", () => void shutdown!(0));
process.stdout.write("ready\n");

}
