#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { startCodexCore } from "./main.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing required argument ${name}`);
  return value;
}

function optional(name: string): string | undefined { return process.argv.includes(name) ? argument(name) : undefined; }

async function main() {
  const token = (await readFile(argument("--token-file"), "utf8")).trim();
  let shutdown: ((code: number) => Promise<void>) | undefined;
  const core = await startCodexCore({
    endpoint: argument("--endpoint"), authToken: token,
    executable: argument("--codex-executable"), runtimeDirectory: argument("--runtime-directory"),
    dataDirectory: argument("--data-directory"), nativeCodexHomeDirectory: argument("--native-codex-home-directory"),
    appServerEndpoint: optional("--app-server-endpoint"),
    proxyPort: optional("--proxy-port") === undefined ? undefined : Number(argument("--proxy-port")),
    onFailure: error => { console.error(error.message); void shutdown?.(1); },
  });
  shutdown = async (code: number) => { await core.close(); process.exit(code); };
  process.once("SIGTERM", () => void shutdown!(0));
  process.once("SIGINT", () => void shutdown!(0));
  process.stdout.write(`${JSON.stringify({ type: process.argv.includes("--app-server-endpoint") ? "codex-accounts-listening" : "codex-core-ready", ...core.health })}\n`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
