import type { IntlShape } from "@opencraft/i18n";
import type { ModalRequest } from "./modal/modal-controller";

export function sideChatCloseRequest(
  intl: Pick<IntlShape, "formatMessage">,
  onConfirm: () => void,
  onDismiss: () => void,
): ModalRequest {
  return {
    id: "close-side-chat",
    label: intl.formatMessage({ id: "panel.sideChat.closeTitle", defaultMessage: "Close side chat?" }),
    layer: "confirmation",
    size: "compact",
    appearance: "utility",
    onDismiss,
    content: intl.formatMessage({
      id: "panel.sideChat.closeDescription",
      defaultMessage: "This temporary conversation will be discarded. It cannot be recovered.",
    }),
    confirmation: {
      cancelLabel: intl.formatMessage({ id: "panel.sideChat.keepChatting", defaultMessage: "Keep chatting" }),
      confirmLabel: intl.formatMessage({ id: "panel.sideChat.close", defaultMessage: "Close side chat" }),
      confirmVariant: "destructive",
      onConfirm,
    },
  };
}
