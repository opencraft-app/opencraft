#!/usr/bin/env node
import { readFile, lstat } from "node:fs/promises";
import { startOpenCraftDaemon } from "./main.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment ${name}`);
  return value;
}

async function bridgeConfiguration() {
  const path = argument('--codex-agent-bridge-config');
  if (!path) return undefined;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 65536 || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw Error();
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['url','token','serverId','inboxPath'].every(key => typeof (value as Record<string, unknown>)[key] === 'string')) throw Error();
    return value as import('@opencraft/agent-bridge-host/gateway').BridgeGatewayOptions;
  } catch { throw Error('Invalid private Codex bridge configuration'); }
}

void (async () => startOpenCraftDaemon({
  endpoint: requiredArgument("--endpoint"),
  runtimeDirectory: requiredArgument("--runtime-directory"),
  authToken: requiredEnvironment("OPENCRAFT_DAEMON_AUTH_TOKEN"),
  dshExecutable: requiredArgument("--dsh-executable"),
  dshCapabilityPlugin: argument("--dsh-capability-plugin"),
  dataDirectory: requiredArgument("--data-directory"),
  humanAccountDirectory: argument('--human-account-directory'),
  modelStorageDirectory: argument("--model-storage-directory"),
  skillsDirectory: argument("--skills-directory"),
  codexExecutable: requiredArgument("--codex-executable"),
  codexDataDirectory: requiredArgument("--codex-data-directory"),
  nativeCodexHomeDirectory: requiredArgument("--native-codex-home-directory"),
  codexCoreEndpoint: argument("--codex-core-endpoint"),
  codexAgentBridge: await bridgeConfiguration(),
  codexWriterOwnership: process.argv.includes("--codex-writer-ownership"),
  machineName: argument("--machine-name"),
}))().then((daemon) => {
  process.stdout.write(`${JSON.stringify({ type: "opencraft-daemon-ready", endpoint: daemon.endpoint, pid: process.pid })}\n`);
  const shutdown = () => void daemon.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
