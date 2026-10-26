import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { createContext, forwardRef, useContext, useState, type ComponentPropsWithoutRef, type PointerEventHandler } from "react";
import { useTouchMenuTrigger } from "./use-touch-menu-trigger";

// Radix retains menu semantics, focus, keyboard, portals and dismissal. Only the
// direct pointer opening gesture differs: scrolling is never an opening intent.
export * from "@radix-ui/react-dropdown-menu";

const Activation = createContext<{ open: boolean; change(open: boolean): void } | null>(null);

export function Root({ open: controlled, defaultOpen = false, onOpenChange, children, ...props }: ComponentPropsWithoutRef<typeof Primitive.Root>) {
  const [local, setLocal] = useState(defaultOpen);
  const open = controlled ?? local;
  const change = (next: boolean) => {
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  return <Primitive.Root {...props} open={open} onOpenChange={change}>
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

export { Root as DropdownMenu, Trigger as DropdownMenuTrigger };
