import "./navigation-hint-surface.scss";
import * as Popover from "@radix-ui/react-popover";
import { CloseIcon } from "@opencraft/design-system-web/action-icons";
import { IconButton } from "@opencraft/design-system-web/button";
import { useIntl } from "@opencraft/i18n/react";
import { usePresence } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { usePresentationCompletion } from "../use-presentation-completion";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import type { ModalSurfaceProps } from "./modal-surface";

/** The Shell owns navigation anchors; Radix owns collision, focus and dismissal.
 * Wait for a visible entry during Shell startup; never invent a detached anchor. */
export function NavigationHintSurface({ anchorNavigationId, children, onDismiss, ...props }:
  ModalSurfaceProps & { readonly anchorNavigationId?: string }) {
  const intl = useIntl();
  const portal = useWorkbenchPresentationRoot();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const virtualRef = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const [present, remove] = usePresence();
  usePresentationCompletion(content, !present, present, remove ?? (() => {}));
  const reason = useRef<"system" | "escape-key" | "outside-press" | "close-button">("system");

  useLayoutEffect(() => {
    const root = portal?.getRootNode() ?? document;
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return element.isConnected && !element.closest('[inert], [aria-hidden="true"]')
        && element.checkVisibility() && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    let target: HTMLElement | null = null;
    const resize = new ResizeObserver(() => check());
    const check = () => {
      if (target && visible(target)) return;
      const candidates = (root as Document | ShadowRoot).querySelectorAll<HTMLElement>(
        `[data-action-id="${CSS.escape(anchorNavigationId ?? "")}"]`,
      );
      const next = [...candidates].find(visible) ?? null;
      if (target && !next) {
        // Navigation may remount while the Shell finishes connecting. Keep the
        // request with its semantic entry, but never leave a detached popover.
        resize.disconnect();
        virtualRef.current = null;
        setAnchor(null);
        mutation.disconnect();
        mutation.observe(root, { childList: true, subtree: true, attributes: true,
          attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"] });
      }
      target = next;
      if (target) {
        virtualRef.current = target;
        setAnchor(target);
        resize.disconnect();
        resize.observe(target);
        // Once positioned, only observe removal; Radix tracks movement and size.
        mutation.disconnect();
        mutation.observe(root, { childList: true, subtree: true });
      }
    };
    const mutation = new MutationObserver(check);
    mutation.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"] });
    check();
    window.addEventListener("resize", check);
    return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener("resize", check); };
  }, [anchorNavigationId, portal]);

  if (!anchor) return null;
  const closeLabel = intl.formatMessage({ id: "common.close", defaultMessage: "Close" });
  return <Popover.Root open={present} onOpenChange={open => { if (!open) onDismiss(reason.current); }}>
    <Popover.Anchor virtualRef={virtualRef} />
    <Popover.Portal container={portal ?? undefined}>
      <Popover.Content ref={content} className="navigation-hint-surface" side="top" align="start"
        sideOffset={12} collisionPadding={12} aria-label={props.label}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (reason.current !== "outside-press" && anchor.isConnected && anchor.checkVisibility()) anchor.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={event => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
          else reason.current = "escape-key";
        }}
        // Shell startup may restore a composer focus after this hint opens.
        // A nonmodal reminder stays available; only an outside press dismisses it.
        onFocusOutside={event => event.preventDefault()}
        onInteractOutside={event => {
          if (props.dismissOnOutsidePress === false) event.preventDefault();
          else reason.current = "outside-press";
        }}>
        {children}
        <Popover.Close asChild><IconButton aria-label={closeLabel} className="navigation-hint-surface__close"
          onClick={() => { reason.current = "close-button"; }}><CloseIcon size={16} /></IconButton></Popover.Close>
        <Popover.Arrow className="navigation-hint-surface__arrow" width={12} height={6} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
