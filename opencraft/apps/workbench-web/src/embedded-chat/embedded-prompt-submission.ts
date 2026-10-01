import type { ComposerController, SubmitIntent } from "@opencraft/composer-core";

/** Host-owned admission, never a DOM click or a second transport writer. */
export function submitEmbeddedPrompt(
  composer: ComposerController,
  hostId: string,
  ready: boolean,
  text: string,
  submit: (intent: SubmitIntent) => boolean,
): boolean {
  const snapshot = composer.getSnapshot();
  const target = snapshot.draft.target;
  if (!ready || !text.trim() || target.type !== "new-thread"
    || target.execution.hostId !== hostId || snapshot.hasContent
    || snapshot.draft.lifecycle.phase !== "editing") return false;
  composer.dispatch({ type: "set-document", document: {
    version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
  } });
  // Until admitted the Composer and caller's pending storage retain the text.
  if (!submit(composer.createSubmitIntent())) return false;
  composer.dispatch({ type: "clear" });
  return true;
}
