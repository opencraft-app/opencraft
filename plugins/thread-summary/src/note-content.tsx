import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { useIntl } from "@opencraft/i18n/react";
import { defineMessages } from "@opencraft/i18n";
import { Button } from "@opencraft/design-system-web/button";
import { TextFileIcon } from "@opencraft/design-system-web/action-icons";
import { WebChatDocument } from "@opencraft/chat-render-web";
import type { ConversationNoteTransport } from "@opencraft/workbench-panels-react";
import { conversationNote, remoteEdit } from "./note-client";

const messages = defineMessages({
  title: { id: "threadSummary.note.title", defaultMessage: "Shared note" },
  placeholder: { id: "threadSummary.note.placeholder", defaultMessage: "Write notes, decisions or links in Markdown…" },
  edit: { id: "threadSummary.note.edit", defaultMessage: "Edit" },
  preview: { id: "threadSummary.note.preview", defaultMessage: "Preview" },
  loading: { id: "threadSummary.note.loading", defaultMessage: "Loading…" },
  saved: { id: "threadSummary.note.saved", defaultMessage: "Saved" },
  saving: { id: "threadSummary.note.saving", defaultMessage: "Saving…" },
  offline: { id: "threadSummary.note.offline", defaultMessage: "Not synced. Your edits are kept here; reconnect to save." },
});

export function ThreadNoteContent({ transport, scopeKey, current }: { transport: ConversationNoteTransport; scopeKey: string; current: boolean }) {
  const intl = useIntl();
  const client = useMemo(() => conversationNote(transport), [transport]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [preview, setPreview] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const selection = useRef<{ start: Y.RelativePosition; end: Y.RelativePosition; direction: "forward" | "backward" | "none" } | null>(null);
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  useLayoutEffect(() => {
    const before = (transaction: Y.Transaction) => {
      const element = input.current;
      if (transaction.origin !== remoteEdit || composing.current || !element || element.ownerDocument.activeElement !== element) return;
      selection.current = { start: Y.createRelativePositionFromTypeIndex(client.text, element.selectionStart), end: Y.createRelativePositionFromTypeIndex(client.text, element.selectionEnd), direction: element.selectionDirection };
    };
    const after = (transaction: Y.Transaction) => {
      // An empty poll must not leave a selection to be replayed on the next keystroke.
      if (transaction.origin === remoteEdit && ![...transaction.changed.keys()].some(type => Object.is(type, client.text))) selection.current = null;
    };
    client.doc.on("beforeTransaction", before);
    client.doc.on("afterTransaction", after);
    return () => {
      client.doc.off("beforeTransaction", before);
      client.doc.off("afterTransaction", after);
      if (composing.current && input.current) client.replace(input.current.value);
      composing.current = false;
      client.composition(false);
    };
  }, [client]);
  useLayoutEffect(() => {
    const saved = selection.current;
    selection.current = null;
    if (input.current && !composing.current && input.current.value !== snapshot.markdown) input.current.value = snapshot.markdown;
    if (!saved || !input.current) return;
    const start = Y.createAbsolutePositionFromRelativePosition(saved.start, client.doc);
    const end = Y.createAbsolutePositionFromRelativePosition(saved.end, client.doc);
    if (start && end) input.current.setSelectionRange(start.index, end.index, saved.direction);
  }, [client, snapshot.markdown]);
  return <section className="thread-summary__note" aria-label={t("title")}>
    <div className="thread-summary__note-heading"><TextFileIcon size={18} aria-hidden="true" /><h3>{t("title")}</h3>
      <Button size="sm" variant="ghost" disabled={!snapshot.ready} aria-pressed={preview} onClick={() => setPreview(value => !value)}>{t(preview ? "edit" : "preview")}</Button>
    </div>
    {preview ? <div className="thread-summary__note-preview"><WebChatDocument documentId={`thread-note:${scopeKey}`} source={snapshot.markdown || t("placeholder")} allowWideBlocks={false} externalResourcePolicy="restricted" /></div> :
      <textarea ref={input} className="thread-summary__note-editor" aria-label={t("title")} placeholder={t("placeholder")}
        readOnly={!snapshot.ready || !current} defaultValue={snapshot.markdown} maxLength={64 * 1024} rows={8} spellCheck
        onChange={event => { if (!composing.current) client.replace(event.currentTarget.value); }}
        onCompositionStart={() => { composing.current = true; client.composition(true); }}
        onCompositionEnd={event => { client.replace(event.currentTarget.value); composing.current = false; client.composition(false); }}
        onKeyDown={event => {
          if (!current || composing.current || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
          event.preventDefault();
          if (event.shiftKey) client.undo.redo(); else client.undo.undo();
        }} />}
    <p className="thread-summary__note-status" data-note-status={snapshot.status}>{t(snapshot.status)}</p>
  </section>;
}
