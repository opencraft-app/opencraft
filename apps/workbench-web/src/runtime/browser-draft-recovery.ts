import { encodeComposerTarget, type ComposerTarget } from "@opencraft/composer-core";
import type { ConversationDraftContinuity } from "@opencraft/workbench-runtime";
import type { DraftSlotOwners } from "./browser-draft-slot";

/** Restore account-scoped input in the background for a cold View. */
export class BrowserDraftRecovery {
  private readonly coldViews = new Set<string>();
  private readonly pending = new Map<string, { target: string }>();
  private slots: DraftSlotOwners = new Map();

  markCold = (viewId: string) => { this.coldViews.add(viewId); };
  forget(viewId: string) { this.coldViews.delete(viewId); this.pending.delete(viewId); this.slots.delete(viewId); }
  isPending = (viewId: string) => this.pending.has(viewId);

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
        const attempt = { target };
        const live = () => this.pending.get(viewId) === attempt;
        const finish = () => { if (live()) this.pending.delete(viewId); };
        this.pending.set(viewId, attempt);
        let detach: (() => void) | undefined;
        void import("./browser-draft-slot").then(({ attachSavedDraft }) => {
          if (!live()) return;
          return attachSavedDraft({ viewId, controller, initial, target, slots, find,
            continuity, restorePlacement, live, finish, attached: stop => { detach = stop; } });
        }).catch(finish);
        return () => { finish(); detach?.(); };
      },
      discard: (viewId, target) => {
        const key = encodeComposerTarget(target);
        // An early send can clear the live editor before it has adopted saved input.
        if (this.pending.get(viewId)?.target === key) return;
        const slot = slots.get(viewId);
        continuity.discard(slot?.target === key ? slot.id : viewId, target);
      },
    };
  }
}
