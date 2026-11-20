import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createSandboxAssistantProvider,
  type AssistantSandboxTemplate,
} from "@opencraft/personal-assistant/sandbox";
import type { AssistantEnvironmentProvider } from "@opencraft/personal-assistant/host";
import { e2bSandboxBackend } from "@opencraft/sandbox-e2b";
const invalid = () => {
  throw Error("Private assistant environment configuration unavailable");
};
async function privateText(path: string, max: number) {
  if (!isAbsolute(path)) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > max
    )
      invalid();
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > max) invalid();
    return text;
  } finally {
    await file.close();
  }
}
/** Optional installation assembly. Credentials/endpoints never come from Bot settings. */
export async function loadAssistantEnvironments(
  path?: string,
): Promise<Record<string, AssistantEnvironmentProvider>> {
  if (!path) return {};
  const config = JSON.parse(await privateText(path, 32768));
  const keys = [
    "schemaVersion",
    "backend",
    "apiUrl",
    "sandboxUrl",
    "apiKeyFile",
    "capacity",
    "templates",
    "lease",
    "maxCommandMs",
    "persistentWorkspaces",
  ];
  if (
    !config ||
    Object.keys(config).some((k) => !keys.includes(k)) ||
    config.schemaVersion !== 1 ||
    config.backend !== "e2b" ||
    typeof config.apiKeyFile !== "string" ||
    !Array.isArray(config.templates) ||
    (config.persistentWorkspaces !== undefined &&
      typeof config.persistentWorkspaces !== "boolean") ||
    !config.lease ||
    Object.keys(config.lease).some(
      (k) => !["timeoutMs", "renewEveryMs", "maxLifetimeMs"].includes(k),
    )
  )
    invalid();
  const keyFile = config.apiKeyFile;
  const readApiKey = async () => {
    const key = (await privateText(keyFile, 4096)).trim();
    if (!key || /\s/u.test(key)) invalid();
    return key;
  };
  await readApiKey(); // Only registered, private configured installations are advertised.
  const provider = await createSandboxAssistantProvider({
    backendId: "e2b",
    templates: config.templates as AssistantSandboxTemplate[],
    capacity: config.capacity,
    maxCommandMs: config.maxCommandMs,
    persistentWorkspaces: config.persistentWorkspaces,
    onReconciliation: (identity) =>
      console.warn("assistant_environment_reconciliation_required", identity),
    createBackend: (template, callbacks) =>
      e2bSandboxBackend({
        apiUrl: config.apiUrl,
        sandboxUrl: config.sandboxUrl,
        templateId: template.id,
        python: template.python,
        readApiKey,
        readWorkspaceId: callbacks.workspaceId,
        timeoutMs: config.lease.timeoutMs,
        requestTimeoutMs: 15000,
        lease: {
          renewEveryMs: config.lease.renewEveryMs,
          maxLifetimeMs: config.lease.maxLifetimeMs,
          ...callbacks,
        },
      }),
  });
  return { e2b: provider };
}
