import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { forwardRef, useContext, useState, type ComponentPropsWithoutRef, type PointerEventHandler } from "react";
import { MenuInteraction as Activation } from "./menu-interaction";
import { useTouchMenuTrigger } from "./use-touch-menu-trigger";
import { useRadixMenuWindowBlurGuard } from "./use-radix-menu-window-blur-guard";

// Radix retains menu semantics, focus, keyboard and nested portals. Shared
// outside dismissal uses the native target without a page-wide hit surface.
export * from "@radix-ui/react-dropdown-menu";

export type DropdownMenuProps = Omit<ComponentPropsWithoutRef<typeof Primitive.Root>, "modal"> & {
  /** Native system surfaces may temporarily take window focus without an outside contact. */
  dismissOnWindowBlur?: boolean;
};

export function Root({ open: controlled, defaultOpen = false, onOpenChange, dismissOnWindowBlur = true, children, ...props }: DropdownMenuProps) {
  const [local, setLocal] = useState(defaultOpen);
  const open = controlled ?? local;
  const ignoreWindowBlurClose = useRadixMenuWindowBlurGuard(open, dismissOnWindowBlur);
  const change = (next: boolean) => {
    if (!next && ignoreWindowBlurClose()) return;
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  // Menus leave page hit testing and scrolling native. Auxiliary consumers
  // retain their editor focus lease without a document-wide modal lock.
  return <Primitive.Root {...props} modal={false} open={open} onOpenChange={change}>
    <Activation.Provider value={{ open, change }}>{children}</Activation.Provider>
  </Primitive.Root>;
}

// Intercept Radix's eager pointer handler at the actual trigger. Cancelling a
// touch pointerdown can also suppress WebKit's native click; withholding only
// Radix's handler leaves the browser in charge of pan and click classification.
const PointerTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  asChild?: boolean;
  onUserPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onTouchPointerDown?: PointerEventHandler<HTMLButtonElement>;
}>(function PointerTrigger({ asChild, onPointerDown, onUserPointerDown, onTouchPointerDown, ...props }, ref) {
  const Control = asChild ? Slot : "button";
  return <Control {...props} ref={ref} onPointerDown={event => {
    onUserPointerDown?.(event);
    if (event.defaultPrevented) return;
    if (event.pointerType === "touch" || event.pointerType === "pen") onTouchPointerDown?.(event);
    else onPointerDown?.(event);
  }} />;
});

export const Trigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Primitive.Trigger>>(function Trigger(
  { asChild, children, disabled, onPointerDown, onClick, onKeyDown, onContextMenu, ...props }, ref,
) {
  const activation = useContext(Activation);
  const touch = useTouchMenuTrigger(!disabled && activation !== null, () => activation?.change(!activation.open));
  return <Primitive.Trigger {...props} ref={ref} disabled={disabled} asChild
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) touch.onClick?.(event); }}
    onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) touch.onKeyDown?.(event); }}
    onContextMenu={event => { onContextMenu?.(event); if (!event.defaultPrevented) touch.onContextMenu?.(event); }}
  >
    <PointerTrigger asChild={asChild} onUserPointerDown={onPointerDown} onTouchPointerDown={touch.onPointerDown}>
      {children}
    </PointerTrigger>
  </Primitive.Trigger>;
});

export const Content = Primitive.Content;

export { Root as DropdownMenu, Trigger as DropdownMenuTrigger, Content as DropdownMenuContent };
