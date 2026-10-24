import type { ConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";
import { findStandaloneHostComposerAction, type HostComposerCommand } from "@opencraft/workbench-runtime";
import type { PanelToolbarActionContext, PanelToolbarActionDefinition } from "@opencraft/workbench-panels";

/** A client action; never sent to a Host as prompt or follow-up input. */
export const SIDE_CHAT_COMPOSER_COMMAND: HostComposerCommand = {
  name: "side", kind: "action",
  description: { id: "panel.sideChat", defaultMessage: "New side chat" },
};

export function runSideChatComposerCommand(intent: SubmitIntent, input: {
  readonly key: ConversationKey | null;
  readonly authoritative: boolean;
  readonly action: PanelToolbarActionDefinition | undefined;
  readonly context: PanelToolbarActionContext;
}): Promise<boolean> | null {
  if (!findStandaloneHostComposerAction(intent, [SIDE_CHAT_COMPOSER_COMMAND])) return null;
  if (!input.authoritative || !input.key || intent.target.type !== "existing-thread"
    || intent.target.key.hostId !== input.key.hostId || intent.target.key.threadId !== input.key.threadId
    || !input.action || !(input.action.isAvailable?.(input.context) ?? true)) {
    throw new Error("Side chat is unavailable for this conversation");
  }
  return Promise.resolve(input.action.run(input.context)).then(() => true);
}
