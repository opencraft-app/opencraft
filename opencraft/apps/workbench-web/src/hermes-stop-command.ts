import { composerDocumentToPlainText, type SubmitIntent } from "@opencraft/composer-core";

export function isStandaloneHermesStop(intent: SubmitIntent): boolean {
  return intent.attachments.length === 0
    && intent.context.length === 0
    && intent.document.blocks.length === 1
    && intent.document.blocks[0]?.type === "paragraph"
    && composerDocumentToPlainText(intent.document).trim() === "/stop";
}
