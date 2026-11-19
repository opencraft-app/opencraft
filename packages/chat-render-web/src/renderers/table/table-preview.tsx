import { PreviewSurface } from "@opencraft/design-system-web/preview-surface";
import { CloseIcon } from "@opencraft/design-system-web/action-icons";
import { IconButton } from "@opencraft/design-system-web/button";
import { useIntl } from "@opencraft/i18n/react";
import type { ReactNode } from "react";
import type { usePreviewFocusOrigin } from "../../preview-focus-origin";
import previewStyles from "./table-preview.scss?inline";
function CloseGlyph() {
  return <CloseIcon size={16} />;
}
export function TablePreview({
  children,
  onClose,
  onKeyboardNavigation,
  returnFocus,
  open,
  openedByPointer,
}: {
  readonly children: ReactNode;
  readonly returnFocus?: () => HTMLElement | null;
  readonly onClose: () => void;
  readonly onKeyboardNavigation: ReturnType<typeof usePreviewFocusOrigin>["onPreviewKeyDown"];
  readonly open: boolean;
  readonly openedByPointer: boolean;
}) {
  const intl = useIntl();
  if (!open) return null;
  return (
    <PreviewSurface
      returnFocus={returnFocus}
      styles={previewStyles}
      label={intl.formatMessage({ id: "chat.table.preview", defaultMessage: "Table preview" })}
      className="chat-table-preview"
      openedByPointer={openedByPointer}
      onClose={onClose}
      onKeyDown={onKeyboardNavigation}
    >
      {(close) => (
        <>
          <div className="chat-table-preview__toolbar">
            <span>{intl.formatMessage({ id: "chat.table.preview", defaultMessage: "Table preview" })}</span>
            <IconButton
              aria-label={intl.formatMessage({ id: "chat.table.close", defaultMessage: "Close table preview" })}
              onClick={close}
              type="button"
            >
              <CloseGlyph />
            </IconButton>
          </div>
          <div className="chat-table-preview__content">{children}</div>
        </>
      )}
    </PreviewSurface>
  );
}
