#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { startCodexGenerationService, inspectRouterMaintenanceService } from "./generation-service.js";
import { readNativeHistoryFailures } from "./native-history-read.js";

const argument = (name: string) => {
  const i = process.argv.indexOf(name), value = i >= 0 ? process.argv[i + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required argument ${name}`);
  return value;
};
async function main() {
  const startup = new AbortController(); let stop: (() => Promise<void>) | undefined;
  const close = () => { startup.abort(); void stop?.(); };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  const scope = argument("--systemd-scope");
  if (scope !== "system" && scope !== "user") throw new Error("Invalid systemd scope");
  const tokenFile = argument("--token-file");
  const options: Parameters<typeof startCodexGenerationService>[0] = { endpoint: argument("--endpoint"), coreEndpoint: argument("--core-endpoint"),
    tokenFile, token: (await readFile(tokenFile, "utf8")).trim(), dataDirectory: argument("--data-directory"),
    registryDirectory: argument("--registry-directory"), systemdScope: scope,
    requireHostUsage: !process.argv.includes("--native-only"),
    nativeHistoryFailures: process.argv.includes("--native-history-failures-file") ? await readNativeHistoryFailures(argument("--native-history-failures-file")) : undefined,
    bootstrap: process.argv.includes("--bootstrap-file") ? JSON.parse(await readFile(argument("--bootstrap-file"), "utf8")) : undefined,
    maintenanceFile: process.argv.includes("--router-maintenance-file") ? argument("--router-maintenance-file") : undefined,
    signal: startup.signal };
  if (process.argv.includes("--router-maintenance-inspect")) {
    const value = await inspectRouterMaintenanceService(options, process.argv.includes("--router-maintenance-continuing"), process.argv.includes("--router-maintenance-provisional"), process.argv.includes("--router-maintenance-host-restart"));
    await writeFile(argument("--router-maintenance-inspect"), JSON.stringify(value), { mode: 0o600, flag: "wx" }); return;
  }
  if (process.argv.includes("--router-maintenance-continuing") || process.argv.includes("--router-maintenance-provisional") || process.argv.includes("--router-maintenance-host-restart")) throw Error("Continuing proof requires explicit read-only inspection");
  const service = await startCodexGenerationService(options);
  stop = async () => { await service.close(); process.exit(0); };
  if (startup.signal.aborted) { await stop(); return; }
  process.stdout.write(JSON.stringify({ type: "codex-routing-owner-ready", pid: process.pid }) + "\n");
}
void main().catch((reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error("Unknown startup failure");
  const frame = error.stack?.split("\n").slice(1).find(line => /:\d+:\d+\)?$/u.test(line));
  const code = (error as NodeJS.ErrnoException).code;
  // No exception message, argv, response body or credentials are written here.
  console.error(JSON.stringify({ event: "codex-routing-owner-failed", name: error.name,
    code: typeof code === "string" && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : null,
    function: frame?.trim().match(/^at (?:async )?([A-Za-z0-9_.$]+)/u)?.[1] ?? null,
    bundleLine: Number(frame?.match(/:(\d+):\d+\)?$/u)?.[1]) || null }));
  process.exitCode = 1;
});
