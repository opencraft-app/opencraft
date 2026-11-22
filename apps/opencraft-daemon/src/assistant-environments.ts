import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createSandboxAssistantProvider,
  type AssistantSandboxTemplate,
} from "@opencraft/personal-assistant/sandbox";
import type { AssistantEnvironmentProvider } from "@opencraft/personal-assistant/host";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { e2bSandboxProvider, type E2BInstallation } from "@opencraft/sandbox-e2b";
/** Daemon deployment assembly: the registered providers for assistant environments. */
type AssistantSandboxInstallation = E2BInstallation;
const providers = () => createSandboxProviderRegistry<AssistantSandboxInstallation>({ e2b: e2bSandboxProvider() });
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
    // schemaVersion 1 predates provider selection: an absent backend is E2B.
    (config.backend !== undefined && config.backend !== "e2b") ||
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
  const installation: AssistantSandboxInstallation = {
    backend: "e2b",
    apiUrl: config.apiUrl,
    sandboxUrl: config.sandboxUrl,
  };
  // Unknown or unregistered backends fail closed; there is no local fallback.
  const registry = providers(),
    definition = registry.resolve(installation);
  if (config.persistentWorkspaces && !registry.supports(installation.backend, "persistentWorkspaces")) invalid();
  const provider = await createSandboxAssistantProvider({
    backendId: installation.backend,
    templates: config.templates as AssistantSandboxTemplate[],
    capacity: config.capacity,
    maxCommandMs: config.maxCommandMs,
    persistentWorkspaces: config.persistentWorkspaces,
    onReconciliation: (identity) =>
      console.warn("assistant_environment_reconciliation_required", identity),
    createBackend: (template, callbacks) =>
      definition.createBackend({
        installation,
        readSecret: readApiKey,
        templateId: template.id,
        ...(template.python === undefined ? {} : { python: template.python }),
        readWorkspaceId: callbacks.workspaceId,
        timeoutMs: config.lease.timeoutMs,
        requestTimeoutMs: 15000,
        lease: {
          renewEveryMs: config.lease.renewEveryMs,
          maxLifetimeMs: config.lease.maxLifetimeMs,
          authorize: callbacks.authorize,
          onLost: callbacks.onLost,
        },
      }),
  });
  return { [installation.backend]: provider };
}
