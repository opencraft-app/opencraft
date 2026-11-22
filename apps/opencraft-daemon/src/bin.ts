#!/usr/bin/env node
import { readCodexBridgeConfiguration } from "./bridge-execution-admission.js";
import { closeInheritedDescriptors } from "./inherited-descriptors.js";
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

function codexSource(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "explicit" || value === "builtin" || value === "user-installed" || value === "unresolved") return value;
  throw new Error("--codex-executable-source must be explicit, builtin, user-installed or unresolved");
}

// Before anything starts children: the desktop app's DevTools socket must not outlive it.
closeInheritedDescriptors();

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
  codexExecutableSource: codexSource(argument("--codex-executable-source")),
  codexDataDirectory: requiredArgument("--codex-data-directory"),
  nativeCodexHomeDirectory: requiredArgument("--native-codex-home-directory"),
  codexCoreEndpoint: argument("--codex-core-endpoint"),
  codexCoreHostOverlays: process.argv.includes("--codex-core-host-overlays"),
  codexAgentBridge: await readCodexBridgeConfiguration(argument('--codex-agent-bridge-config')),
  codexAgentBridgeAdoptExisting: process.argv.includes('--codex-agent-bridge-adopt-existing'),
  ...(argument("--codex-bridge-stack") ? { codexBridgeStack: { programs: requiredArgument("--codex-bridge-stack") } } : {}),
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
