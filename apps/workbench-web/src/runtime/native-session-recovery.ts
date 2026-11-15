import { AppServerRpcError } from "@opencraft/appserver-client";
import { createConversationKey } from "@opencraft/chat-core";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

/** Only a pre-prompt native rejection permits automatic transfer of this input. */
export function nativeSessionBusyBeforeInput(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  const data = error.data as { code?: unknown; inputNotSent?: unknown } | undefined;
  return data?.code === "CODEX_SESSION_BUSY" && data.inputNotSent === true;
}

export async function continueNativeSessionInBranch(input: {
  intent: SubmitIntent;
  current(): boolean;
  supportsFork(): Promise<boolean>;
  fork(): Promise<string>;
  open(threadId: string): Promise<boolean>;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
}): Promise<SubmissionReceipt> {
  const { intent } = input;
  if (intent.target.type !== "existing-thread" || !intent.target.key.threadId.startsWith("codex_")
    || !input.current() || !await input.supportsFork() || !input.current()) throw new Error("Conversation handoff is no longer available");
  const threadId = await input.fork();
  // An acknowledged child survives a superseded route, but must not steal
  // navigation or dispatch the old input after a newer user intent.
  if (!input.current() || !await input.open(threadId)) throw new Error("The new conversation was created; open it from the conversation list");
  return input.submit({ ...intent, target: { type: "existing-thread", key: createConversationKey(intent.target.key.hostId, threadId) } });
}
