import type { AttachedInteractionTimelineBlock } from "@opencraft/chat-core";

export interface InteractionDraftEntry {
  readonly identity: string;
  readonly values: Map<string, unknown>;
}

/** Presentation IDs and transport allocations do not create a new request. */
export function interactionDraftIdentity(block: AttachedInteractionTimelineBlock): string {
  const { id: _id, sourceItemIds: _sources, state: _state, ...definition } = block;
  return JSON.stringify(definition);
}

/** Application memory only. A View retains its last pending input, never permission. */
export class InteractionDraftStore {
  private readonly entries = new Map<string, InteractionDraftEntry>();

  prepare(scope: string, identity: string): InteractionDraftEntry {
    const existing = this.entries.get(scope);
    if (existing?.identity === identity) return existing;
    return { identity, values: new Map<string, unknown>() };
  }

  retain(scope: string, entry: InteractionDraftEntry): void {
    this.entries.set(scope, entry);
  }

  release(scope: string, entry: InteractionDraftEntry): void {
    if (this.entries.get(scope) === entry) this.entries.delete(scope);
  }
}
