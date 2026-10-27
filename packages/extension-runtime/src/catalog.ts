import type { ExtensionManagerSnapshot } from "./manager";
import type { ExtensionRuntimeSnapshot } from "./runtime";
import type { ExtensionContributionSnapshot } from "./contribution-store";

export interface ExtensionCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: string;
  readonly source: "builtin" | "installed";
  readonly sourceUrl: string | null;
  readonly enabled: boolean;
  readonly status: string;
  readonly error: string | null;
  readonly updateError: string | null;
  readonly capabilities: readonly string[];
  readonly canManage: boolean;
  readonly canReload: boolean;
  readonly canRemove: boolean;
}

/** Derived directory only. Installation intent, live activation and contributions retain their owners. */
export function projectExtensionCatalog(
  runtime: ExtensionRuntimeSnapshot,
  installations: ExtensionManagerSnapshot,
  contributions: ExtensionContributionSnapshot,
): readonly ExtensionCatalogItem[] {
  const installed = new Map(installations.extensions.map(row => [row.installation.extensionId, row]));
  const live = new Map(runtime.extensions.map(row => [row.id, row]));
  return [...new Set([...live.keys(), ...installed.keys()])].map(id => {
    const managed = installed.get(id);
    const running = live.get(id);
    const manifest = managed?.installation.lastResolvedManifest;
    const status = managed?.status ?? running?.status ?? "failed";
    const groups = [
      ["命令", contributions.commands], ["视图", contributions.views], ["设置", contributions.settingsPages],
      ["主题", contributions.themes], ["导航", contributions.navigation], ["Bot", contributions.bots],
    ] as const;
    return {
      id, name: manifest?.name ?? running?.name ?? id,
      description: manifest?.description ?? running?.description ?? null,
      version: manifest?.version ?? running?.version ?? "",
      source: managed?.installation.source.kind === "module-url" ? "installed" as const : "builtin" as const,
      sourceUrl: managed?.installation.source.kind === "module-url" ? managed.installation.source.url : null,
      enabled: managed?.installation.enabled ?? status === "active",
      status,
      error: status === "active" ? null : managed?.error ?? running?.error ?? null,
      updateError: status === "active" ? managed?.error ?? null : null,
      capabilities: groups.filter(([, rows]) => rows.some(row => row.owner.extensionId === id)).map(([label]) => label),
      canManage: managed !== undefined,
      canReload: managed?.installation.source.kind === "module-url",
      canRemove: managed?.installation.source.kind === "module-url",
    };
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
