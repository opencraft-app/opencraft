import { encodeComposerTarget, type ComposerTarget } from "@opencraft/composer-core";
import type { ConversationDraftContinuity } from "@opencraft/workbench-runtime";
import type { DraftSlotOwners } from "./browser-draft-slot";

/** Route identity is available immediately. Only its editor waits for the
 * account-scoped storage slot and the corresponding document to be read. */
export class BrowserDraftRecovery {
  private readonly coldViews = new Set<string>();
  private readonly pending = new Map<string, symbol>();
  private readonly listeners = new Set<() => void>();
  private slots: DraftSlotOwners = new Map();

  markCold = (viewId: string) => { this.coldViews.add(viewId); };
  forget(viewId: string) { this.coldViews.delete(viewId); this.slots.delete(viewId); }
  isPending = (viewId: string) => this.pending.has(viewId);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }

  bind(continuity: ConversationDraftContinuity, find: (target: ComposerTarget, preferred: string) => Promise<string | null>,
    restorePlacement: (target: Extract<ComposerTarget, { type: "new-thread" }>) => void): ConversationDraftContinuity {
    const slots: DraftSlotOwners = new Map();
    this.slots = slots;
    return {
      attach: (viewId, controller) => {
        const initial = controller.getSnapshot().draft;
        const target = encodeComposerTarget(initial.target);
        if (!this.coldViews.has(viewId)) {
          slots.set(viewId, { target, id: viewId });
          return continuity.attach(viewId, controller);
        }
        const token = Symbol();
        const live = () => this.pending.get(viewId) === token;
        const finish = () => { if (live()) { this.pending.delete(viewId); this.publish(); } };
        this.pending.set(viewId, token);
        this.publish();
        let detach: (() => void) | undefined;
        void import("./browser-draft-slot").then(({ attachSavedDraft }) => {
          if (!live()) return;
          return attachSavedDraft({ viewId, controller, initial, target, slots, find,
            continuity, restorePlacement, live, finish, attached: stop => { detach = stop; } });
        }).catch(finish);
        return () => { finish(); detach?.(); };
      },
      discard(viewId, target) {
        const slot = slots.get(viewId);
        continuity.discard(slot?.target === encodeComposerTarget(target) ? slot.id : viewId, target);
      },
    };
  }
}
