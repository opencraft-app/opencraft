import type { ConversationKey } from "./identity";

/** Product ownership is independent of engine, fork provenance and history storage.
 * A native fork is independent unless its creator explicitly assigns an owner.
 * Ownership describes presentation/lifecycle; it never grants execution access. */
export type ConversationOwnership =
  | { readonly kind: "independent" }
  | { readonly kind: "side-chat"; readonly owner: ConversationKey };

export const independentConversationOwnership: ConversationOwnership = Object.freeze({ kind: "independent" });

export function belongsInOrdinaryConversationCatalog(ownership: ConversationOwnership): boolean {
  return ownership.kind === "independent";
}
