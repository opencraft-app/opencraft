import { useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { workbenchIconMetrics, opencraftColorTokens } from "@opencraft/design-system/tokens";
import { ColorInput } from "@opencraft/design-system-web/color-input";
import { IconButton, Button } from "@opencraft/design-system-web/button";
import { CheckIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import {
  conversationAppearanceKey,
  conversationColorNames,
  conversationIconNames,
  type ConversationAppearance,
} from "@opencraft/ui-preferences";
import { useAsyncNotices } from "./async-notices";
import { ModalSurface } from "./modal/modal-surface";
import {
  Artwork,
  fallback,
  useAppearance,
  useConversationAppearanceActions,
  type Target,
} from "./conversation-appearance";
import "./conversation-appearance-picker.scss";

const iconMessages = {
  chat: { id: "chat.appearance.icon.chat", defaultMessage: "Chat" },
  folder: { id: "chat.appearance.icon.folder", defaultMessage: "Folder" },
  chart: { id: "chat.appearance.icon.chart", defaultMessage: "Chart" },
  book: { id: "chat.appearance.icon.book", defaultMessage: "Book" },
  code: { id: "chat.appearance.icon.code", defaultMessage: "Code" },
  terminal: { id: "chat.appearance.icon.terminal", defaultMessage: "Terminal" },
  pencil: { id: "chat.appearance.icon.pencil", defaultMessage: "Writing" },
  palette: { id: "chat.appearance.icon.palette", defaultMessage: "Art" },
  globe: { id: "chat.appearance.icon.globe", defaultMessage: "Globe" },
  target: { id: "chat.appearance.icon.target", defaultMessage: "Goal" },
  briefcase: { id: "chat.appearance.icon.briefcase", defaultMessage: "Work" },
  calendar: { id: "chat.appearance.icon.calendar", defaultMessage: "Calendar" },
  lightning: { id: "chat.appearance.icon.lightning", defaultMessage: "Lightning" },
  brain: { id: "chat.appearance.icon.brain", defaultMessage: "Thinking" },
  people: { id: "chat.appearance.icon.people", defaultMessage: "People" },
  tool: { id: "chat.appearance.icon.tool", defaultMessage: "Tools" },
  image: { id: "chat.appearance.icon.image", defaultMessage: "Image" },
  star: { id: "chat.appearance.icon.star", defaultMessage: "Sparkles" },
};
const colorMessages = {
  default: { id: "chat.appearance.color.default", defaultMessage: "Default color" },
  red: { id: "chat.appearance.color.red", defaultMessage: "Red" },
  orange: { id: "chat.appearance.color.orange", defaultMessage: "Orange" },
  yellow: { id: "chat.appearance.color.yellow", defaultMessage: "Yellow" },
  green: { id: "chat.appearance.color.green", defaultMessage: "Green" },
  blue: { id: "chat.appearance.color.blue", defaultMessage: "Blue" },
  purple: { id: "chat.appearance.color.purple", defaultMessage: "Purple" },
  pink: { id: "chat.appearance.color.pink", defaultMessage: "Pink" },
};
export default function AppearancePicker({
  target,
  returnFocus,
  onDismiss,
}: {
  target: Target;
  returnFocus(): HTMLElement | null;
  onDismiss(): void;
}) {
  const context = useConversationAppearanceActions()!;
  const appearance = useAppearance(target);
  const current = appearance ?? fallback;
  const intl = useIntl();
  const notices = useAsyncNotices();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [custom, setCustom] = useState(
    current.color.startsWith("#") ? current.color : opencraftColorTokens.light.accent.purple,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = async (value: ConversationAppearance | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const key = conversationAppearanceKey(context.scope, target.hostId, target.threadId);
    try {
      await context.preferences.update("chat.conversationAppearances", (values) => {
        const next = { ...values };
        if (value) next[key] = value;
        else delete next[key];
        return next;
      });
      notices.dismiss(`appearance:${key}`);
    } catch {
      if (mounted.current)
        notices.error({
          key: `appearance:${key}`,
          detail: target.title,
          message: intl.formatMessage({
            id: "chat.appearance.failed",
            defaultMessage: "Could not save the icon. Try again.",
          }),
        });
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const label = intl.formatMessage({ id: "chat.appearance.title", defaultMessage: "Conversation icon" });
  return (
    <ModalSurface
      label={label}
      size="compact"
      appearance="utility"
      className="conversation-appearance-dialog"
      returnFocus={returnFocus}
      onDismiss={onDismiss}
    >
      <div className="conversation-appearance-picker" aria-busy={pending}>
        <div className="conversation-appearance-picker__heading">
          <Artwork appearance={current} size={workbenchIconMetrics.overview.heading} />
          <h2>{label}</h2>
        </div>
        <fieldset disabled={pending}>
          <legend>{intl.formatMessage({ id: "chat.appearance.colors", defaultMessage: "Color" })}</legend>
          <div className="conversation-appearance-picker__grid">
            {conversationColorNames.map((color) => (
              <IconButton
                key={color}
                aria-label={intl.formatMessage(colorMessages[color])}
                variant={current.color === color ? "secondary" : "ghost"}
                aria-pressed={current.color === color}
                onClick={() => void save({ ...current, color })}
              >
                <span
                  className="conversation-appearance-swatch conversation-appearance-color"
                  data-color={color}
                  aria-hidden="true"
                >
                  {current.color === color ? <CheckIcon size={workbenchIconMetrics.core.settings} /> : null}
                </span>
              </IconButton>
            ))}
          </div>
          <div className="conversation-appearance-picker__custom">
            <label>
              {intl.formatMessage({ id: "chat.appearance.custom", defaultMessage: "Custom color" })}
              <ColorInput value={custom} onChange={(event) => setCustom(event.target.value)} />
            </label>
            <Button size="sm" variant="ghost" onClick={() => void save({ ...current, color: custom })}>
              {intl.formatMessage({ id: "common.apply", defaultMessage: "Apply" })}
            </Button>
          </div>
        </fieldset>
        <fieldset disabled={pending}>
          <legend>{intl.formatMessage({ id: "chat.appearance.icons", defaultMessage: "Icon" })}</legend>
          <div className="conversation-appearance-picker__grid">
            {conversationIconNames.map((icon) => (
              <IconButton
                key={icon}
                aria-label={intl.formatMessage(iconMessages[icon])}
                variant={current.icon === icon ? "secondary" : "ghost"}
                aria-pressed={current.icon === icon}
                onClick={() => void save({ ...current, icon })}
              >
                <Artwork appearance={{ icon, color: current.color }} size={workbenchIconMetrics.overview.heading} />
              </IconButton>
            ))}
          </div>
        </fieldset>
        <div className="conversation-appearance-picker__actions">
          <Button size="sm" variant="ghost" disabled={!appearance || pending} onClick={() => void save(null)}>
            <ResetIcon size={workbenchIconMetrics.core.settings} aria-hidden="true" />
            {intl.formatMessage({ id: "chat.appearance.reset", defaultMessage: "Restore default" })}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss}>
            {intl.formatMessage({ id: "common.done", defaultMessage: "Done" })}
          </Button>
        </div>
      </div>
    </ModalSurface>
  );
}
