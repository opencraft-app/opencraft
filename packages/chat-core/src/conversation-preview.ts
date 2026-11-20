import { ChatDocumentCompiler, chatDocumentPlainText } from '@opencraft/chat-document';
import type { TimelineFrame, TextTimelineBlock } from './timeline';

export interface ConversationPreviewMessage { readonly role: 'user' | 'assistant'; readonly text: string }
/** Read-only overview projection: latest user and latest answer, never older progress above a conclusion. */
export function conversationPreview(frames: readonly TimelineFrame[]): readonly ConversationPreviewMessage[] {
  let user: string | undefined, latest: TextTimelineBlock | undefined, final: TextTimelineBlock | undefined;
  outer: for (let i = frames.length - 1; i >= 0; i--) {
    const blocks = frames[i]!.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]!;
      if (block.type === 'user-message') { user = block.message; break outer; }
      if (block.type === 'text' && block.text.trim()) {
        latest ??= block;
        if (block.phase === 'final_answer') final ??= block;
      }
    }
  }
  const compiler = new ChatDocumentCompiler();
  const plain = (text: string) => chatDocumentPlainText(compiler.compile(text.slice(0, 8000)).nodes).replace(/\s+/g, ' ').trim().slice(0, 600);
  const answer = final ?? latest;
  return [user === undefined ? null : { role: 'user' as const, text: plain(user) }, answer ? { role: 'assistant' as const, text: plain(answer.text) } : null]
    .filter((value): value is ConversationPreviewMessage => value !== null && value.text.length > 0);
}
