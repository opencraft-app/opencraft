#!/usr/bin/env node
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

void startOpenCraftDaemon({
  endpoint: requiredArgument("--endpoint"),
  runtimeDirectory: requiredArgument("--runtime-directory"),
  authToken: requiredEnvironment("OPENCRAFT_DAEMON_AUTH_TOKEN"),
  dshExecutable: requiredArgument("--dsh-executable"),
  dshCapabilityPlugin: argument("--dsh-capability-plugin"),
  dataDirectory: requiredArgument("--data-directory"),
  modelStorageDirectory: argument("--model-storage-directory"),
  skillsDirectory: argument("--skills-directory"),
  codexExecutable: requiredArgument("--codex-executable"),
  codexDataDirectory: requiredArgument("--codex-data-directory"),
  nativeCodexHomeDirectory: requiredArgument("--native-codex-home-directory"),
  codexCoreEndpoint: argument("--codex-core-endpoint"),
  codexWriterOwnership: process.argv.includes("--codex-writer-ownership"),
  machineName: argument("--machine-name"),
}).then((daemon) => {
  process.stdout.write(`${JSON.stringify({ type: "opencraft-daemon-ready", endpoint: daemon.endpoint, pid: process.pid })}\n`);
  const shutdown = () => void daemon.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
