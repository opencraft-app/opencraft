import type { UiPreferencesRuntime, UiPreferenceValues } from "@opencraft/ui-preferences";

type Availability = UiPreferenceValues["chat.agentAvailability"];
const writes = new WeakMap<UiPreferencesRuntime, Promise<void>>();

export function agentAvailabilityScope(display: string, account: string, hostId: string): string {
  return JSON.stringify([display, account, hostId]);
}

export function isAgentEnabled(values: Availability, scope: string, agentId: string): boolean {
  return values[scope]?.[agentId] !== false;
}

/** Chat settings write the host the user is editing. A new draft applies that
 * switch to the same agent wherever its models are listed, so closing Codex
 * cannot leave it selectable on another host. */
export function filterModelsForNewDraft<T extends { agentId?: string | null }>(
  models: readonly T[],
  modelHostId: string,
  settingsHostId: string,
  enabled: (hostId: string, agentId: string) => boolean,
): T[] {
  return models.filter(model => enabled(settingsHostId, model.agentId ?? "host") && modelHostId.length >= 0);
}

export function newDraftAgentsDisabled<T extends { agentId?: string | null }>(
  groups: readonly { readonly hostId: string; readonly models: readonly T[] }[],
  settingsHostId: string,
  enabled: (hostId: string, agentId: string) => boolean,
): boolean {
  const declared = groups.flatMap(group => group.models.map(model => ({ model, hostId: group.hostId })));
  return declared.length > 0 && declared.every(({ model, hostId }) => filterModelsForNewDraft([model], hostId, settingsHostId, enabled).length === 0);
}

/** Settings and onboarding merge each intent after the preceding durable write.
 * A failed write leaves the visible preference unchanged and never poisons the queue. */
export function setAgentEnabled(preferences: UiPreferencesRuntime, scope: string, agentId: string, enabled: boolean, isCurrent: () => boolean = () => true): Promise<void> {
  const previous = writes.get(preferences) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await preferences.update("chat.agentAvailability", current => isCurrent()
      ? { ...current, [scope]: { ...current[scope], [agentId]: enabled } } : current);
  }).finally(() => { if (writes.get(preferences) === next) writes.delete(preferences); });
  writes.set(preferences, next);
  return next;
}
