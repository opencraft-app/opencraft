import { EditIcon as Pencil } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAsyncNotices } from "./async-notices";

/** Mount per Host/Thread identity so navigation retires the old edit session. */
export function EditableThreadTitle({ title, project, onRename }: {
  readonly title: string;
  readonly project?: string;
  readonly onRename: (title: string) => Promise<void>;
}) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const saving = useRef(false);
  const editing = useRef(false);
  const restoreFocus = useRef(false);
  const notices = useAsyncNotices();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
    else if (restoreFocus.current) { restoreFocus.current = false; triggerRef.current?.focus(); }
  }, [open]);
  const label = intl.formatMessage({ id: "common.rename", defaultMessage: "Rename" });
  const dismiss = (focus: boolean) => {
    editing.current = false;
    restoreFocus.current = focus;
    setOpen(false);
  };
  const save = async (focus: boolean) => {
    if (!editing.current || saving.current) return;
    const value = draft.trim();
    if (!value || value === title) { dismiss(focus); return; }
    saving.current = true;
    setBusy(true);
    try {
      await onRename(value);
      if (mounted.current) dismiss(focus);
    } catch {
      if (mounted.current) notices.error({ key: "title-rename", message: intl.formatMessage({ id: "chat.rename.failed", defaultMessage: "Could not rename the conversation. Try again." }) });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return open ? <div className="thread-header-edit no-drag">
    <input
      ref={inputRef}
      className="thread-header-edit__input"
      aria-label={intl.formatMessage({ id: "chat.rename.name", defaultMessage: "Conversation name" })}
      title={intl.formatMessage({ id: "chat.rename.hint", defaultMessage: "Enter to save, Esc to cancel" })}
      aria-busy={busy}
      maxLength={60}
      readOnly={busy}
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { void save(false); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void save(true); }
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (!saving.current) dismiss(true);
        }
      }}
    />
  </div> : <span className="thread-header-copy thread-header-copy--editable">
    <strong>{title}</strong>
    <button
      ref={triggerRef}
      className="chrome-button no-drag thread-header-rename"
      type="button"
      title={label}
      aria-label={label}
      onClick={() => { editing.current = true; setDraft(title); setOpen(true); }}
    ><Pencil aria-hidden="true" size={14} /></button>
    {project ? <small>{project} · main</small> : null}
  </span>;
}
