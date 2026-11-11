import type { UiPreferencesRuntime, UiPreferenceValues } from "@opencraft/ui-preferences";

type Availability = UiPreferenceValues["chat.agentAvailability"];
const writes = new WeakMap<UiPreferencesRuntime, Promise<void>>();

export function agentAvailabilityScope(display: string, account: string, hostId: string): string {
  return JSON.stringify([display, account, hostId]);
}

export function isAgentEnabled(values: Availability, scope: string, agentId: string): boolean {
  return values[scope]?.[agentId] !== false;
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
