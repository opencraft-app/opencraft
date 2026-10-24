import * as Popover from "@radix-ui/react-popover";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { SettingsButton, SettingsTextInput } from "./settings-controls";

/** Utility-window content geometry; the host's Radix Dialog owns modality. */
export function SettingsPanel({ title, actions, footer, children }: {
  title: ReactNode; actions?: ReactNode; footer?: ReactNode; children: ReactNode;
}) {
  return <div className="settings-panel">
    <header className="settings-panel__header"><h2>{title}</h2><div className="settings-panel__actions">{actions}</div></header>
    <div className="settings-panel__body">{children}</div>
    {footer ? <footer className="settings-panel__footer">{footer}</footer> : null}
  </div>;
}

export const SettingsIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function SettingsIconButton({ label, className, children, ...props }, ref) {
    return <button {...props} ref={ref} type={props.type ?? "button"} title={label} aria-label={label}
      className={["settings-control-button settings-icon-button", className].filter(Boolean).join(" ")}>
      <span aria-hidden="true">{children}</span>
    </button>;
  },
);

function copyWithSelection(value: string, container: HTMLElement): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  container.appendChild(field);
  try {
    field.focus();
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
    focused?.focus({ preventScroll: true });
  }
}

export function SettingsCopyButton({ value, label, icon, iconOnly = false, successLabel = "Copied", errorLabel = "Could not copy. Please try again." }: {
  value: string; label: string; icon?: ReactNode; iconOnly?: boolean; successLabel?: string; errorLabel?: string;
}) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (container.current && copyWithSelection(value, container.current)) return;
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
    await navigator.clipboard.writeText(value);
  };
  return <span className="settings-copy-control" ref={container}>
    <SettingsButton type="button" variant="quiet" title={label} aria-label={label} className={iconOnly ? "settings-copy-control__icon-button" : undefined} onClick={() => {
      setStatus("");
      void copy().then(() => {
        setStatus(successLabel);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus(""), 2000);
      }).catch(() => setStatus(errorLabel));
    }}><span aria-hidden="true">{icon}</span>{iconOnly ? null : label}</SettingsButton>
    <span className="settings-copy-control__status" role="status">{status}</span>
  </span>;
}

/** Radix owns opening, collision, Escape, focus capture and focus restoration. */
export function SettingsEditableText({ value, label, icon, disabled, maxLength = 80, onSave }: {
  value: string; label: string; icon: ReactNode; disabled?: boolean; maxLength?: number; onSave(value: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return <span className="settings-editable-text">
    <strong title={value}>{value}</strong>
    <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setDraft(value); setError(null); } }}>
      <Popover.Trigger asChild><SettingsIconButton label={`Edit ${label.toLowerCase()}`} disabled={disabled}>{icon}</SettingsIconButton></Popover.Trigger>
      <Popover.Portal><Popover.Content className="settings-edit-popover" sideOffset={6} collisionPadding={12} align="start" aria-label={`Edit ${label.toLowerCase()}`}>
        <form onSubmit={event => {
          event.preventDefault(); if (!draft.trim() || saving) return;
          setSaving(true); setError(null);
          void onSave(draft.trim()).then(() => setOpen(false)).catch(cause => setError(cause instanceof Error ? cause.message : "Could not save. Please retry."))
            .finally(() => setSaving(false));
        }}>
          <label htmlFor={id}>{label}</label>
          <SettingsTextInput id={id} value={draft} maxLength={maxLength} disabled={saving} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
            onChange={event => setDraft(event.currentTarget.value)} />
          {error ? <small id={`${id}-error`} role="alert">{error}</small> : null}
          <div className="settings-edit-popover__actions">
            <Popover.Close asChild><SettingsButton variant="quiet" type="button">Cancel</SettingsButton></Popover.Close>
            <SettingsButton type="submit" variant="primary" disabled={saving || !draft.trim()}>{saving ? "Saving…" : "Save"}</SettingsButton>
          </div>
        </form>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </span>;
}

export function SettingsAvatarEditor({ src, name, icon, disabled, onUpload, onError }: {
  src: string | null; name: string; icon: ReactNode; disabled?: boolean;
  onUpload(file: File): Promise<void>; onError(message: string | null): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  return <>
    <button type="button" className="settings-avatar-editor" aria-label={uploading ? "Uploading avatar" : "Change avatar"}
      disabled={disabled || uploading} aria-busy={uploading} onClick={() => input.current?.click()}>
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase() || "L"}</span>}
      <i aria-hidden="true">{icon}</i>
    </button>
    <input ref={input} hidden type="file" accept="image/png,image/jpeg" onChange={event => {
      const file = event.currentTarget.files?.[0]; if (!file || uploading) return;
      setUploading(true); onError(null);
      void onUpload(file).catch(cause => onError(cause instanceof Error ? cause.message : "Avatar upload failed."))
        .finally(() => { setUploading(false); if (input.current) input.current.value = ""; });
    }} />
  </>;
}

export function SettingsUsageMeter({ value, maximum, label, tone = "neutral" }: {
  value: number; maximum: number; label: string; tone?: "neutral" | "warning" | "error";
}) {
  const max = Number.isFinite(maximum) && maximum > 0 ? maximum : 1;
  const current = Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
  return <progress className="settings-usage-meter" data-tone={tone} aria-label={label} max={max} value={current} />;
}
