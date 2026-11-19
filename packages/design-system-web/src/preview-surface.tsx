import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEventHandler,
  type MouseEventHandler,
} from "react";
import { usePresentationCompletion } from "./presentation-completion";
const styles = `
@keyframes opencraft-preview-enter { from { opacity: 0; } to { opacity: 1; } }
@keyframes opencraft-preview-exit { from { opacity: 1; } to { opacity: 0; } }
.opencraft-preview-surface[open] { animation: opencraft-preview-enter var(--transition-duration-basic, 150ms) ease-out both; }
.opencraft-preview-surface[data-closing] { animation-name: opencraft-preview-exit; pointer-events: none; }
.opencraft-preview-surface::backdrop { animation: opencraft-preview-enter var(--transition-duration-basic, 150ms) ease-out both; }
.opencraft-preview-surface[data-closing]::backdrop { animation-name: opencraft-preview-exit; }
@media (prefers-reduced-motion: reduce) { .opencraft-preview-surface[open], .opencraft-preview-surface::backdrop { animation: none; } }
`;
function activeElement(): HTMLElement | null {
  let target: Element | null = document.activeElement;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  return target instanceof HTMLElement ? target : null;
}
export interface PreviewSurfaceProps {
  readonly label: string;
  readonly className?: string;
  readonly styles?: string;
  readonly children: (close: () => void) => ReactNode;
  readonly onClose: () => void;
  readonly returnFocus?: () => HTMLElement | null;
  readonly openedByPointer?: boolean;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  readonly dismissOnBackground?: boolean;
  readonly onClick?: MouseEventHandler<HTMLDialogElement>;
}
/** Native top-layer preview: preserves the caller's ShadowRoot and shares focus,
 * IME dismissal and completion-driven motion for every read-only content kind. */
export function PreviewSurface({
  label,
  className,
  styles: contentStyles,
  children,
  onClose,
  returnFocus,
  openedByPointer,
  onKeyDown,
  onClick,
  dismissOnBackground,
}: PreviewSurfaceProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef({ onClose, returnFocus });
  latest.current = { onClose, returnFocus };
  const [presented, setPresented] = useState(false);
  const [closing, setClosing] = useState(false);
  const requested = useRef(false);
  const close = useCallback(() => {
    if (!requested.current) {
      requested.current = true;
      setClosing(true);
    }
  }, []);
  const complete = useCallback(() => latest.current.onClose(), []);
  usePresentationCompletion(dialog, closing, closing, complete);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const origin = activeElement();
    element.showModal();
    setPresented(true);
    return () => {
      element.close();
      const target = latest.current.returnFocus?.() ?? origin;
      if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      className={["opencraft-preview-surface", className].filter(Boolean).join(" ")}
      data-opened-by-pointer={openedByPointer || undefined}
      data-closing={closing || undefined}
      inert={closing || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (dismissOnBackground && event.target === event.currentTarget && !event.defaultPrevented) close();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else onKeyDown?.(event);
      }}
    >
      <style data-opencraft-preview-motion children={styles} />
      {contentStyles && <style data-opencraft-preview-content children={contentStyles} />}
      {presented && children(close)}
    </dialog>
  );
}
