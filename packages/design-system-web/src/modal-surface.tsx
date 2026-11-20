import { usePresence } from 'motion/react';
import { usePresentationCompletion } from './presentation-completion';
import { CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import type {
  ModalDescriptor,
  ModalDismissReason,
} from "@opencraft/design-system/modal";
import * as Dialog from "@radix-ui/react-dialog";

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useWorkbenchPresentationRoot } from "./presentation-root";

export interface ModalSurfaceProps extends ModalDescriptor {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onDismiss: (reason: ModalDismissReason) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly stackIndex?: number;
  readonly returnFocus?: () => HTMLElement | null;
  /** A presentation owner may defer restoration until its controls are interactive. */
  readonly deferReturnFocus?: (resolve: () => HTMLElement | null) => void;
  readonly closeLabel?: string;
  /** Navigation surfaces must not summon an IME merely by opening. */
  readonly initialFocus?: "surface";
  /** Fullscreen scene canvases own their backdrop; modality still belongs here. */
  readonly dimBackground?: boolean;
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
  deferReturnFocus,
  initialFocus,
  dimBackground = true,
  stackIndex = 0,
}: ModalSurfaceProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [present, remove] = usePresence();
  useLayoutEffect(() => {
    if (present) contentRef.current?.style.removeProperty('--modal-sheet-offset');
  }, [present]);
  usePresentationCompletion(contentRef, !present, present, remove ?? (() => {}));
  const presentationRoot = useWorkbenchPresentationRoot();
  const dismissReason = useRef<ModalDismissReason>("system");
  const opener = useRef((() => {let target:Element|null=document.activeElement;while(target?.shadowRoot?.activeElement)target=target.shadowRoot.activeElement;return target instanceof HTMLElement?target:null;})());
  const surfaceClassName = className === undefined
    ? "modal-surface"
    : `modal-surface ${className}`;
  const layerStyle: ModalLayerStyle = {
    "--modal-stack-offset": stackIndex * 2,
  };

  return (
    <Dialog.Root
      modal
      open={present}
      onOpenChange={(open) => {
        if (!open) onDismiss(dismissReason.current);
      }}
    >
      <Dialog.Portal container={portalContainer ?? presentationRoot ?? undefined}>
        <Dialog.Overlay
          className="modal-surface__scrim"
          data-presentation={presentation}
          data-layer={layer}
          data-appearance={appearance}
          data-stack-index={stackIndex}
          data-dimmed={dimBackground}
          style={dimBackground ? layerStyle : { ...layerStyle, background: "transparent" }}
        />
        <Dialog.Content
          ref={contentRef}
          onOpenAutoFocus={event => {
            if (initialFocus === "surface") {
              event.preventDefault();
              contentRef.current?.focus({ preventScroll: true });
            }
          }}
          aria-label={label}
          aria-describedby={undefined}
          className={surfaceClassName}
          data-layer={layer}
          data-appearance={appearance}
          data-presentation={presentation}
          data-viewport-owner={portalContainer || presentationRoot ? "presentation" : "document"}
          data-size={size}
          data-stack-index={stackIndex}
          style={layerStyle}
          onEscapeKeyDown={(event) => {
            // The input method owns Escape until its composition has ended.
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
            else dismissReason.current = "escape-key";
          }}
          onPointerDownOutside={(event) => {
            if (!dismissOnOutsidePress) {
              event.preventDefault();
              return;
            }
            dismissReason.current = "outside-press";
          }}
          onCloseAutoFocus={event => {
            if (deferReturnFocus) {
              event.preventDefault();
              deferReturnFocus(() => returnFocus?.() ?? opener.current);
              return;
            }
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

