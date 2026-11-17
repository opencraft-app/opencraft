import { useId } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsTextInput } from "@opencraft/extension-react";
import { ModalSurface } from "./modal";
import "./conversation-rename-dialog.scss";

/** Shared presentation for header and sidebar; the caller owns the draft and write. */
export function EntityRenameDialog({ value, pending, onChange, onSubmit, onDismiss, returnFocus, title, nameLabel, error, maxLength = 60 }: {
  readonly title: string;
  readonly nameLabel: string;
  readonly error?: string;
  readonly maxLength?: number;
  readonly value: string;
  readonly pending: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onDismiss: () => void;
  readonly returnFocus?: () => HTMLElement | null;
}) {
  const intl = useIntl();
  const titleId = useId();
  return <ModalSurface label={title} size="compact" appearance="utility" className="conversation-rename-dialog"
    onDismiss={() => { if (!pending) onDismiss(); }} returnFocus={returnFocus}>
    <form aria-labelledby={titleId} onSubmit={event => {
      event.preventDefault();
      if (!pending && value.trim()) onSubmit(value.trim());
    }}>
      <h2 id={titleId}>{title}</h2>
      <SettingsTextInput autoFocus aria-label={nameLabel} aria-invalid={!!error}
        onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
        maxLength={maxLength} autoCapitalize="sentences" autoComplete="off" spellCheck={false}
        value={value} disabled={pending} onChange={event => onChange(event.target.value)}
        onFocus={event => { if (!matchMedia("(pointer: coarse)").matches) event.currentTarget.select(); }} />
      {error ? <p role="alert">{error}</p> : null}
      <div className="conversation-rename-dialog__actions">
        <SettingsButton type="button" disabled={pending} onClick={onDismiss}>
          {intl.formatMessage({ id: "common.cancel", defaultMessage: "Cancel" })}
        </SettingsButton>
        <SettingsButton type="submit" variant="primary" disabled={!value.trim()} loading={pending}>
          {intl.formatMessage(pending ? { id: "sidebar.thread.saving", defaultMessage: "Saving…" } : { id: "common.save", defaultMessage: "Save" })}
        </SettingsButton>
      </div>
    </form>
  </ModalSurface>;
}

export function ConversationRenameDialog(props: Omit<Parameters<typeof EntityRenameDialog>[0], "title" | "nameLabel" | "error" | "maxLength">) {
  const intl = useIntl();
  return <EntityRenameDialog {...props}
    title={intl.formatMessage({ id: "chat.rename.title", defaultMessage: "Rename conversation" })}
    nameLabel={intl.formatMessage({ id: "chat.rename.name", defaultMessage: "Conversation name" })} />;
}
