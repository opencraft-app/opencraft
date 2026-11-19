import type { ConversationKey, TurnId } from "@opencraft/chat-core";

import type { ComposerTarget, SubmitIntent } from "./model";

/**
 * Follow-up policy while an AppServer turn is active.
 *
 * `queue` waits for the active turn to finish. `steer` changes that turn now.
 * This is domain state shared by Web and Native composers, not a button style.
 */
export type ComposerFollowUpAction = "queue" | "steer";

export type ComposerPrimaryAction = "send" | "stop" | ComposerFollowUpAction;

export interface ResolveComposerPrimaryActionOptions {
  readonly isResponseInProgress: boolean;
  readonly canSubmit: boolean;
  readonly defaultFollowUpAction: ComposerFollowUpAction;
  readonly availableFollowUpActions?: readonly ComposerFollowUpAction[];
}

/** Preferences choose among admitted operations; they never create abilities. */
export function resolveComposerFollowUpAction(
  preferred: ComposerFollowUpAction,
  available: readonly ComposerFollowUpAction[] = ["queue", "steer"],
): ComposerFollowUpAction | null {
  return available.includes(preferred) ? preferred : available[0] ?? null;
}

export function resolveComposerPrimaryAction({
  isResponseInProgress,
  canSubmit,
  defaultFollowUpAction,
  availableFollowUpActions,
}: ResolveComposerPrimaryActionOptions): ComposerPrimaryAction {
  if (!isResponseInProgress) return "send";
  return canSubmit ? resolveComposerFollowUpAction(defaultFollowUpAction, availableFollowUpActions) ?? "stop" : "stop";
}

/** Stop stays reachable while a response is running, even if a follow-up can also be sent. */
export function composerTrailingControls(options: ResolveComposerPrimaryActionOptions): {
  readonly stop: boolean;
  readonly primary: ComposerPrimaryAction | null;
} {
  const primary = resolveComposerPrimaryAction(options);
  if (!options.isResponseInProgress) return { stop: false, primary };
  return { stop: true, primary: primary === "stop" ? null : primary };
}

export function invertComposerFollowUpAction(
  action: ComposerFollowUpAction,
): ComposerFollowUpAction {
  return action === "queue" ? "steer" : "queue";
}

export function targetForComposerFollowUp(
  key: ConversationKey,
  activeTurnId: TurnId,
  action: ComposerFollowUpAction,
): ComposerTarget {
  return action === "queue"
    ? { type: "enqueue-follow-up", key }
    : { type: "steer-active-turn", key, turnId: activeTurnId };
}

/** Retargets one immutable submission without mutating the preserved draft. */
export function retargetSubmitIntentForFollowUp(
  intent: SubmitIntent,
  key: ConversationKey,
  activeTurnId: TurnId,
  action: ComposerFollowUpAction,
): SubmitIntent {
  return {
    ...intent,
    target: targetForComposerFollowUp(key, activeTurnId, action),
  };
}
