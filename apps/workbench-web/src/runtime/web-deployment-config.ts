import { parseServerInstalledExtensions, type ServerInstalledExtension } from './server-installed-extensions';
import { readSelectionPreference, writeSelectionPreference } from "./selection-preferences";
// Website-owned data, injected before the application module starts. Electron
// never reads this contract; a static/Vite deployment has no injected element.
import { createWorkbenchDraftLocation, createWorkbenchThreadLocation, type WorkbenchLocation } from "@opencraft/workbench-runtime";

export interface WebDeploymentConfig {
  readonly userPlugins?: readonly ServerInstalledExtension[];
  readonly hosts: readonly unknown[];
  readonly builtinAgents: boolean;
  readonly hypernode: boolean;
  readonly fileDownloads?: boolean;
  readonly htmlPreviews?: boolean;
  readonly extensions?: readonly string[];
  readonly machineDisplayNames?: Readonly<Record<string, string>>;
}

export function resolveLegacyWebsiteLocation(location: WorkbenchLocation | null): WorkbenchLocation | null {
  if (location === null) return null;
  if (location.kind === "thread") return location.key.hostId === "hypernode"
    ? createWorkbenchThreadLocation("local", location.key.threadId) : location;
  return location.hostId === "hypernode" ? createWorkbenchDraftLocation("local", location.draftId) : location;
}

/** Additive migration of the legacy Web selection authority, never overwrite local intent. */
export function restoreLegacyWebsiteSelection(storage: Storage) {
  const scope = (key: string) => key;
  for (const prefix of ["opencraft.active-thread-id:", "opencraft.selected-project-id:"]) {
    const localKey = `${prefix}local`;
    const local = readSelectionPreference(storage, localKey, scope);
    const previous = readSelectionPreference(storage, `${prefix}hypernode`, scope);
    if (local === null && previous !== null) writeSelectionPreference(storage, localKey, previous, scope);
  }
  const hostKey = "opencraft.active-host-id";
  if (readSelectionPreference(storage, hostKey, scope) === "hypernode") writeSelectionPreference(storage, hostKey, "local", scope);
}

export function parseWebDeploymentConfig(raw: string | null): WebDeploymentConfig | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid website deployment configuration");
  }
  const record = value as Record<string, unknown>;
  if (record.htmlPreviews !== undefined && typeof record.htmlPreviews !== "boolean") throw new Error("Invalid HTML preview capability");
  if (record.fileDownloads !== undefined && typeof record.fileDownloads !== "boolean") throw new Error("Invalid website file download capability");
  if (!Array.isArray(record.hosts) || typeof record.builtinAgents !== "boolean"
    || typeof record.hypernode !== "boolean") {
    throw new Error("Invalid website deployment configuration");
  }
  if (record.extensions !== undefined && (!Array.isArray(record.extensions) || !record.extensions.every(id => typeof id === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)))) throw new Error("Invalid website extension configuration");
  const names = record.machineDisplayNames;
  if (names !== undefined && (typeof names !== "object" || names === null || Array.isArray(names)
    || Object.entries(names).some(([id, name]) => !id || typeof name !== "string" || !name.trim() || name.trim().length > 64 || /\p{Cc}/u.test(name)))) throw new Error("Invalid website machine display names");
  return { ...(record.htmlPreviews === undefined ? {} : { htmlPreviews: record.htmlPreviews as boolean }), ...(record.fileDownloads === undefined ? {} : { fileDownloads: record.fileDownloads as boolean }), ...(record.userPlugins === undefined ? {} : { userPlugins: parseServerInstalledExtensions(record.userPlugins) }), ...(names === undefined ? {} : { machineDisplayNames: Object.freeze(Object.fromEntries(Object.entries(names).map(([id, name]) => [id, (name as string).trim()]))) }), ...(record.extensions === undefined ? {} : { extensions: record.extensions as string[] }), hosts: record.hosts, builtinAgents: record.builtinAgents, hypernode: record.hypernode };
}

export function resolveWebDeploymentConfig(
  runtime: WebDeploymentConfig | null,
  build: { readonly hosts?: string; readonly builtinAgents?: string; readonly hypernode?: string; readonly extensions?: string },
) {
  return {
    ...((build.extensions !== undefined || runtime?.extensions !== undefined) ? { extensions: build.extensions !== undefined ? build.extensions.split(",").map(id => id.trim()).filter(Boolean) : runtime!.extensions! } : {}),
    hosts: build.hosts?.trim() ? build.hosts
      : runtime && runtime.hosts.length > 0 ? JSON.stringify(runtime.hosts) : undefined,
    builtinAgents: build.builtinAgents === "enabled" ? true
      : build.builtinAgents === "disabled" ? false : runtime?.builtinAgents ?? false,
    hypernode: build.hypernode === "disabled" ? false
      : build.hypernode === "enabled" ? true : runtime?.hypernode ?? true,
  };
}
