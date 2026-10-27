import { beginObservedOperation } from "./observability";
import type { UiPreferencesRuntime, UiPreferenceValues } from "@opencraft/ui-preferences";

type ModelSelections = UiPreferenceValues["chat.modelSelections"];
type ModelSelection = ModelSelections[string];
export interface ModelSelectionScope {
  readonly displayScope: string;
  readonly accountScope: string;
  readonly hostId: string;
}

function selectionKey(scope: ModelSelectionScope): string {
  return JSON.stringify([scope.displayScope, scope.accountScope, scope.hostId]);
}

/** A null scope disables client model memory for embedded presentations. */
export function readModelSelection(selections: ModelSelections, scope: ModelSelectionScope | null): ModelSelection | undefined {
  return scope === null ? undefined : selections[selectionKey(scope)];
}

export async function rememberModelSelection(preferences: UiPreferencesRuntime, scope: ModelSelectionScope | null, selection: ModelSelection): Promise<void> {
  if (scope === null) return;
  const finish=beginObservedOperation("preference_save");
  try {
  await preferences.set("chat.modelSelections", {
    ...preferences.get("chat.modelSelections"),
    [selectionKey(scope)]: selection,
  });
  finish("ok");
  } catch(error){finish("failed");throw error;}
}
