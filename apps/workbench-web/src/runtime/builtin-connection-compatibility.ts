import type { HostConnectionProfileStore } from "@opencraft/workbench-runtime";
import type { ApplicationRoute } from "./workbench-navigation";
import { resolveServerConnectionRoute } from "./server-connection-compatibility";

// Exact first-party inputs formerly emitted by these built-in providers.
const providerAliases = new Map([
  ["vela.builtin-agents", "opencraft.builtin-agents"],
  ["vela.websocket", "opencraft.websocket"],
  ["vela.hypernode", "opencraft.hypernode"],
]);
const settingsAliases = new Map([
  ["vela.builtin-agents.model-services", "opencraft.builtin-agents.model-services"],
  ["vela.builtin-agents.codex-accounts", "opencraft.builtin-agents.codex-accounts"],
  ["vela.headless-model-services", "opencraft.headless-model-services"],
  ["vela.voice-input.settings", "opencraft.voice-input.settings"],
  ["vela.voice-input.web-settings", "opencraft.voice-input.web-settings"],
]);
const viewAliases = new Map([
  ["vela.builtin-agents.model-services-view", "opencraft.builtin-agents.model-services-view"],
  ["vela.builtin-agents.codex-accounts-view", "opencraft.builtin-agents.codex-accounts-view"],
  ["vela.headless-model-services.view", "opencraft.headless-model-services.view"],
  ["vela.voice-input.settings-view", "opencraft.voice-input.settings-view"],
  ["vela.voice-input.web-settings-view", "opencraft.voice-input.web-settings-view"],
  ["vela.bot-chat.view", "opencraft.bot-chat.view"],
  ["vela.bot-management.view", "opencraft.bot-management.view"],
]);

export async function migrateBuiltinConnectionProfiles(store: HostConnectionProfileStore, availableProviders: readonly string[]): Promise<void> {
  const available = new Set(availableProviders);
  for (const profile of store.getSnapshot().profiles) {
    const providerId = providerAliases.get(profile.providerId);
    if (providerId === undefined || !available.has(providerId)) continue;
    await store.put({ ...profile, providerId, revision: profile.revision + 1 });
  }
}

/** Composition-owned exact bookmark recovery; no opaque extension prefix rewrites. */
export function resolveBuiltinConnectionRoute(input: ApplicationRoute, headlessServer: boolean): ApplicationRoute {
  const route = headlessServer ? resolveServerConnectionRoute(input) : input;
  if (route.kind === "settings") {
    const slug = settingsAliases.get(route.slug);
    return slug === undefined ? route : { ...route, slug };
  }
  if (route.kind === "extension-view") {
    const viewId = viewAliases.get(route.viewId);
    return viewId === undefined ? route : { ...route, viewId };
  }
  return route;
}
