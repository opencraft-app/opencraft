import {
  asConversationScopeId,
  canonicalThreadScopeId,
  createWorkbenchThreadLocation,
  type ConversationBindingStore,
  type ConversationScopeRegistry,
  type ConversationViewRegistry,
  type WorkbenchLocation,
} from "@opencraft/workbench-runtime";
import { createRouteScopeId, type RestoredWorkbenchEntry } from "./workbench-navigation";

interface LocationOwners {
  readonly hasHost: (hostId: string) => boolean;
  readonly bindings: Pick<ConversationBindingStore, "resolve" | "findScope">;
  readonly scopes: Pick<ConversationScopeRegistry, "getDraft"> | null;
}

/** History holds references, not the lifetime or canonical identity of resources. */
export function resolveRetainedWorkbenchLocation(
  location: WorkbenchLocation,
  owners: LocationOwners,
): WorkbenchLocation | null {
  const hostId = location.kind === "thread" ? location.key.hostId : location.hostId;
  if (!owners.hasHost(hostId)) return null;
  if (location.kind === "thread") return location;
  const binding = owners.bindings.resolve(asConversationScopeId(location.draftId));
  if (binding?.hostId === hostId && binding.conversationKey !== null) {
    return createWorkbenchThreadLocation(hostId, binding.conversationKey.threadId);
  }
  const draft = owners.scopes?.getDraft(location.draftId);
  return draft?.target.execution.hostId === hostId ? location : null;
}

/** Pure resource projection. Only the Router writes corrected history entries. */
export function createWorkbenchEntryResolver(owners: LocationOwners & {
  readonly views: Pick<ConversationViewRegistry, "get">;
  readonly fallback: () => RestoredWorkbenchEntry;
}): (entry: RestoredWorkbenchEntry) => RestoredWorkbenchEntry {
  return (entry) => {
    const location = resolveRetainedWorkbenchLocation(entry.location, owners);
    if (location === null) return owners.fallback();
    const scopeId = location.kind === "draft"
      ? owners.scopes!.getDraft(location.draftId)!.scopeId
      : owners.bindings.findScope(location.key) ?? canonicalThreadScopeId(location.key);
    const view = owners.views.get(entry.routeScopeId);
    // A promoted Draft may keep its View. A View of a different Scope may not.
    return {
      location,
      routeScopeId: view && view.scopeId !== scopeId ? createRouteScopeId() : entry.routeScopeId,
    };
  };
}
