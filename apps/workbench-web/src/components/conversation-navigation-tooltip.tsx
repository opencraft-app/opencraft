import type { ConversationNavigationPreview } from "@opencraft/chat-navigation";
import { PersonIcon, RefreshIcon } from "@opencraft/design-system-web/action-icons";
import { AvatarImage, IdentityAvatarContext } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { useContext } from "react";
import { createPortal } from "react-dom";

export function ConversationNavigationTooltip({
  id,
  button,
  preview,
  heartbeat,
}: {
  readonly id: string;
  readonly button: HTMLButtonElement;
  readonly preview: ConversationNavigationPreview;
  readonly heartbeat: boolean;
}) {
  const intl = useIntl();
  const avatars = useContext(IdentityAvatarContext);
  const rect = button.getBoundingClientRect();
  return createPortal(
    <div
      className="conversation-navigation-tooltip"
      id={id}
      role="tooltip"
      style={{ left: rect.right, top: rect.top + rect.height / 2 }}
    >
      <div className="conversation-navigation-tooltip__label">
        {preview.sender ? (
          <span
            className="conversation-navigation-tooltip__avatar"
            role="img"
            aria-label={preview.sender.loginName}
            title={preview.sender.loginName}
          >
            <AvatarImage
              src={avatars?.resolve(preview.sender.kind, preview.sender.loginName) ?? null}
              fallback={<PersonIcon size={12} />}
            />
          </span>
        ) : null}
        {heartbeat ? <RefreshIcon size={12} /> : null}
        <span>
          {preview.label || intl.formatMessage({ id: "chat.message.noContent", defaultMessage: "(No content)" })}
        </span>
      </div>
      {preview.response.trim().length > 0 ? (
        <div className="conversation-navigation-tooltip__response">{preview.response}</div>
      ) : null}
      {preview.outputs.length > 0 ? (
        <div className="conversation-navigation-tooltip__outputs">
          {preview.outputs.slice(0, 2).map((output, index) => (
            <span key={`${output.kind}:${output.label ?? index}`}>{output.label ?? output.kind}</span>
          ))}
          {preview.outputs.length > 2 ? <span>+{preview.outputs.length - 2}</span> : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
