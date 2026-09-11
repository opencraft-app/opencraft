import type {
  ModalDescriptor,
  ModalDismissReason,
} from "@opencraft/design-system/modal";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";

export interface ModalSurfaceProps extends ModalDescriptor {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onDismiss: (reason: ModalDismissReason) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly stackIndex?: number;
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
  className,
  dismissOnOutsidePress = true,
  label,
  layer = "application",
  onDismiss,
  portalContainer,
  presentation = "dialog",
  showCloseButton = true,
  size = "default",
  stackIndex = 0,
}: ModalSurfaceProps) {
  const dismissReason = useRef<ModalDismissReason>("system");
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
      <Dialog.Portal container={portalContainer ?? undefined}>
        <Dialog.Overlay
          className="modal-surface__scrim"
          data-layer={layer}
          data-stack-index={stackIndex}
          style={layerStyle}
        />
        <Dialog.Content
          aria-label={label}
          className={surfaceClassName}
          data-layer={layer}
          data-presentation={presentation}
          data-size={size}
          data-stack-index={stackIndex}
          style={layerStyle}
          onPointerDownOutside={(event) => {
            if (!dismissOnOutsidePress) {
              event.preventDefault();
              return;
            }
            dismissReason.current = "outside-press";
          }}
        >
          <Dialog.Title className="modal-surface__accessible-title">
            {label}
          </Dialog.Title>
          {children}
          {showCloseButton ? (
            <Dialog.Close asChild>
              <button
                aria-label={`Close ${label.toLocaleLowerCase()}`}
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
