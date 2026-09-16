import type { ReactNode, RefObject } from "react";
import { CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface FileManagerInlineEditorProps {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  placeholder: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FileManagerInlineEditor({ inputRef, value, placeholder, confirmLabel, cancelLabel, busy, onChange, onConfirm, onCancel }: FileManagerInlineEditorProps) {
  return <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
    <Input ref={inputRef} className="h-9 min-w-0 flex-1 basis-36 rounded-md" value={value} aria-label={placeholder} placeholder={placeholder} disabled={busy}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); onConfirm(); }
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      }} />
    <span className="inline-flex shrink-0 gap-1">
      <Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={confirmLabel} disabled={busy || !value.trim()} onClick={onConfirm}><CheckCircle className="size-4" aria-hidden="true" /></Button>
      <Button type="button" variant="ghost" size="sm" className="size-8 rounded-md p-0" aria-label={cancelLabel} disabled={busy} onClick={onCancel}><XCircle className="size-4" aria-hidden="true" /></Button>
    </span>
  </span>;
}

export interface FileManagerEntryViewProps {
  name: string;
  icon: ReactNode;
  size: string;
  modified: string;
  selected?: boolean;
  directory?: boolean;
  editor?: ReactNode;
  onSelect?: () => void;
  onOpen?: () => void;
}

/** No remote file types or clients: presentation receives only labels, state and actions. */
export function FileManagerEntryView({ name, icon, size, modified, selected, directory, editor, onSelect, onOpen }: FileManagerEntryViewProps) {
  const cells = <>
    <span className={`flex min-w-0 items-center gap-2 ${editor ? "col-span-2 sm:col-span-3" : ""}`}><span className="shrink-0" aria-hidden="true">{icon}</span>{editor ?? <span className="min-w-0 break-all font-medium text-[var(--text-primary)]">{name}</span>}</span>
    <span className="text-xs tabular-nums text-[var(--text-secondary)]">{size}</span>
    <span className={`${editor ? "" : "col-span-2 sm:col-span-1"} text-xs tabular-nums text-[var(--text-secondary)]`}>{modified}</span>
  </>;
  const className = "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm sm:grid-cols-[minmax(0,1fr)_104px_116px]";
  if (editor) return <div className={className}>{cells}</div>;
  return <button type="button" aria-label={name} aria-pressed={Boolean(selected)} className={`${className} ${selected ? "bg-[var(--surface-muted)] ring-1 ring-inset ring-[var(--border-strong)]" : ""} hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]`}
    onClick={onSelect} onDoubleClick={onOpen}
    onKeyDown={(event) => { if (directory && event.key === "Enter") { event.preventDefault(); onOpen?.(); } }}>{cells}</button>;
}
