import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SandboxConfigurations, type InstalledSandboxConfiguration } from "./configurations.js";

function unavailable(): never {
  throw Error("Installed workspace configuration unavailable");
}
async function privateText(path: string, maximum: number) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) unavailable();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > maximum) unavailable();
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > maximum) unavailable();
    return text;
  } finally {
    await file.close();
  }
}
/** Sole Worker bootstrap only. No provider registration/provisioning or secret
 * return. Once adopted, the encrypted installation document is authoritative. */
export async function adoptInstalledWorkspaceConfiguration(
  store: SandboxConfigurations,
  path: string,
): Promise<boolean> {
  if (store.hasInstallation()) return false;
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
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((k) => !keys.includes(k)) ||
    config.schemaVersion !== 1 ||
    // schemaVersion 1 predates provider selection: an absent backend is E2B.
    (config.backend !== undefined && config.backend !== "e2b") ||
    typeof config.apiKeyFile !== "string" ||
    !Array.isArray(config.templates) ||
    config.templates.length > 32
  )
    unavailable();
  for (const template of config.templates) {
    if (
      !template ||
      typeof template !== "object" ||
      Array.isArray(template) ||
      Object.keys(template).some(
        (k) => !["id", "name", "workspaceRoot", "resources", "python", "browser"].includes(k),
      ) ||
      typeof template.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(template.id)
    )
      unavailable();
  }
  const key = (await privateText(config.apiKeyFile, 4096)).trim();
  const delivery: InstalledSandboxConfiguration = {
    backend: "e2b",
    apiUrl: config.apiUrl,
    sandboxUrl: config.sandboxUrl,
    capacity: config.capacity,
    templates: config.templates,
    lease: config.lease,
    ...(config.maxCommandMs === undefined ? {} : { maxCommandMs: config.maxCommandMs }),
    ...(config.persistentWorkspaces === undefined ? {} : { persistentWorkspaces: config.persistentWorkspaces }),
  };
  return store.adoptInstallation(delivery, key);
}
