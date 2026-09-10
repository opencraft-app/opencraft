import { X } from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface ModalSurfaceProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
  readonly onDismiss: () => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Web adapter for an application-modal presentation. This primitive owns the
 * portal, scrim, focus boundary, background inertness and dismissal. Feature
 * content owns neither browser modality nor the underlying application shell.
 */
export function ModalSurface({
  children,
  className,
  label,
  onDismiss,
}: ModalSurfaceProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const applicationShell = document.querySelector<HTMLElement>(".app-shell-root");
    const shellWasInert = applicationShell?.hasAttribute("inert") ?? false;
    const previousAriaHidden = applicationShell?.getAttribute("aria-hidden") ?? null;
    applicationShell?.setAttribute("inert", "");
    applicationShell?.setAttribute("aria-hidden", "true");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (applicationShell !== null) {
        if (!shellWasInert) applicationShell.removeAttribute("inert");
        if (previousAriaHidden === null) applicationShell.removeAttribute("aria-hidden");
        else applicationShell.setAttribute("aria-hidden", previousAriaHidden);
      }
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const surfaceClassName = className === undefined
    ? "modal-surface"
    : `modal-surface ${className}`;

  return createPortal(
    <div
      className="modal-surface__host"
      data-selection="chrome"
      role="presentation"
      onPointerDown={onDismiss}
    >
      <div aria-hidden="true" className="modal-surface__scrim" />
      <section
        ref={dialogRef}
        aria-label={label}
        aria-modal="true"
        className={surfaceClassName}
        role="dialog"
        tabIndex={-1}
        onKeyDown={trapFocus}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
        <button
          ref={closeButtonRef}
          aria-label={`Close ${label.toLocaleLowerCase()}`}
          className="modal-surface__close"
          type="button"
          onClick={onDismiss}
        >
          <X size={18} />
        </button>
      </section>
    </div>,
    document.body,
  );
}
