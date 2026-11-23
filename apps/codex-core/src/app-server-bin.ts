#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineSandboxConfiguration } from "@opencraft/sandbox-node/engine";
import { readFile } from "node:fs/promises";
import { startCodexAppServer } from "./app-server.js";
import { readEnvironmentLaunchConfiguration } from "./environment-launch-config.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing required argument ${name}`);
  return value;
}

async function main() {
  let shutdown: ((code: number) => Promise<void>) | undefined;
  const startup = new AbortController();
  const stop = () => { startup.abort(); if (shutdown) void shutdown(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const configuration = await engineSandboxConfiguration();
  const ownFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const packagedRunner = join(dirname(ownFile), "sandbox-command.mjs");
  const runner = existsSync(packagedRunner) ? packagedRunner : join(dirname(ownFile), "../../../scripts/server-deployment/sandbox-command.mjs");
  const runtime = await startCodexAppServer({
    executionSandbox: configuration ? { configuration, runner } : undefined,
    // Deployment-private channel, never a renderer/provider setting. No default:
    // paired Gateway admission must be installed before enabling strict APP mode.
    workspaceAuthoritySocket: process.env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET,
    projectlessWorkspaceDirectory: process.env.OPENCRAFT_CODEX_PROJECTLESS_DIR,
    endpoint: argument("--endpoint"), coreEndpoint: argument("--core-endpoint"),
    authToken: (await readFile(argument("--token-file"), "utf8")).trim(),
    dataDirectory: argument("--data-directory"), runtimeDirectory: argument("--runtime-directory"),
    runtimeDataDirectory: process.argv.includes("--runtime-data-directory") ? argument("--runtime-data-directory") : undefined,
    executable: argument("--codex-executable"),
    // Trusted private file: the pinned issuer key (or the vault owner's
    // publication, read once here), this owner's attachment and where it reads
    // its own durable admission. Omitted: no delivery.
    environmentLaunch: process.argv.includes("--environment-launch-config")
      ? await readEnvironmentLaunchConfiguration(argument("--environment-launch-config")) : undefined,
    waitForCore: true, signal: startup.signal,
    onFailure: error => { console.error(error.message); void shutdown?.(1); },
  });
  shutdown = async code => { await runtime.close(); process.exit(code); };
  process.stdout.write(`${JSON.stringify({ type: "codex-app-server-ready", pid: process.pid })}\n`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
