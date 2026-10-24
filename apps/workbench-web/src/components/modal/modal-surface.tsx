import { CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import type {
  ModalDescriptor,
  ModalDismissReason,
} from "@opencraft/design-system/modal";
import * as Dialog from "@radix-ui/react-dialog";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";

export interface ModalSurfaceProps extends ModalDescriptor {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onDismiss: (reason: ModalDismissReason) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly stackIndex?: number;
  readonly returnFocus?: () => HTMLElement | null;
  readonly closeLabel?: string;
}

type ModalLayerStyle = CSSProperties & {
  "--modal-stack-offset": number;
};

/**
 * Web platform adapter for one modal window. Radix exclusively owns modality,
 * focus trapping/restoration, Escape, outside interaction and the DOM portal.
 */
export function ModalSurface({
  children,
  appearance = "default",
  className,
  closeLabel,
  dismissOnOutsidePress = true,
  label,
  layer = "application",
  onDismiss,
  portalContainer,
  presentation = "dialog",
  showCloseButton = true,
  size = "default",
  returnFocus,
  stackIndex = 0,
}: ModalSurfaceProps) {
  const presentationRoot = useWorkbenchPresentationRoot();
  const dismissReason = useRef<ModalDismissReason>("system");
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const surfaceClassName = className === undefined
    ? "modal-surface"
    : `modal-surface ${className}`;
  const layerStyle: ModalLayerStyle = {
    "--modal-stack-offset": stackIndex * 2,
  };

  return (
    <Dialog.Root
      modal
      open
      onOpenChange={(open) => {
        if (!open) onDismiss(dismissReason.current);
      }}
    >
      <Dialog.Portal container={portalContainer ?? presentationRoot ?? undefined}>
        <Dialog.Overlay
          className="modal-surface__scrim"
          data-layer={layer}
          data-appearance={appearance}
          data-stack-index={stackIndex}
          style={layerStyle}
        />
        <Dialog.Content
          aria-label={label}
          aria-describedby={undefined}
          className={surfaceClassName}
          data-layer={layer}
          data-appearance={appearance}
          data-presentation={presentation}
          data-size={size}
          data-stack-index={stackIndex}
          style={layerStyle}
          onEscapeKeyDown={(event) => {
            // The input method owns Escape until its composition has ended.
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissOnOutsidePress) {
              event.preventDefault();
              return;
            }
            dismissReason.current = "outside-press";
          }}
          onCloseAutoFocus={event => {
            const target = returnFocus?.() ?? opener.current;
            if (target?.isConnected && !target.closest("[inert]")) {
              event.preventDefault(); target.focus({ preventScroll: true });
            }
          }}
        >
          <Dialog.Title className="modal-surface__accessible-title">
            {label}
          </Dialog.Title>
          {children}
          {showCloseButton ? (
            <Dialog.Close asChild>
              <button
                aria-label={closeLabel ?? `Close ${label.toLocaleLowerCase()}`}
                className="modal-surface__close"
                type="button"
                onClick={() => {
                  dismissReason.current = "close-button";
                }}
              >
                <X aria-hidden="true" size={18} />
              </button>
            </Dialog.Close>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
