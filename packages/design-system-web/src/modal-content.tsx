import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef, useRef, type ComponentProps } from "react";
import { useWorkbenchPresentationRoot } from "./presentation-root";
export interface ModalContentProps extends ComponentProps<typeof Dialog.Content> {
  readonly portalContainer?: HTMLElement | null;
  readonly overlayClassName?: string;
  readonly overlayProps?: ComponentProps<typeof Dialog.Overlay> & {
    [attribute: `data-${string}`]: string | number | boolean | undefined;
  };
}
/** Shared portal, material and modality adapter for controlled Radix roots.
 * Domain forms retain their content, pending state and dismiss policy. */
export const ModalContent = forwardRef<HTMLDivElement, ModalContentProps>(function ModalContent(
  {
    portalContainer,
    overlayClassName,
    overlayProps,
    className,
    onEscapeKeyDown,
    onCloseAutoFocus,
    onOpenAutoFocus,
    ...props
  },
  ref,
) {
  const root = useWorkbenchPresentationRoot();
  const origin = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Portal container={portalContainer ?? root ?? undefined}>
      <Dialog.Overlay className={overlayClassName ?? "modal-surface__scrim"} data-layer="nested" {...overlayProps} />
      <Dialog.Content
        aria-describedby={undefined}
        data-layer="nested"
        data-appearance="utility"
        data-size="default"
        {...props}
        ref={ref}
        className={
          className?.split(" ").includes("modal-surface")
            ? className
            : ["modal-surface", className].filter(Boolean).join(" ")
        }
        onOpenAutoFocus={(event) => {
          let target: Element | null = document.activeElement;
          while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
          origin.current = target instanceof HTMLElement ? target : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = origin.current;
          if (!event.defaultPrevented && target?.isConnected && !target.closest("[inert]")) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
          onEscapeKeyDown?.(event);
        }}
      />
    </Dialog.Portal>
  );
});
