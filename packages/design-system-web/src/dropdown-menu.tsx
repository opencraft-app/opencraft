import * as Primitive from "@radix-ui/react-dropdown-menu";
import { createContext, forwardRef, useContext, useState, type ComponentPropsWithoutRef } from "react";
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

export const Trigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Primitive.Trigger>>(function Trigger(
  { disabled, onPointerDown, onClick, onKeyDown, onContextMenu, ...props }, ref,
) {
  const activation = useContext(Activation);
  const touch = useTouchMenuTrigger(!disabled && activation !== null, () => activation?.change(!activation.open));
  return <Primitive.Trigger {...props} ref={ref} disabled={disabled}
    onPointerDown={event => { onPointerDown?.(event); if (!event.defaultPrevented) touch.onPointerDown?.(event); }}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) touch.onClick?.(event); }}
    onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) touch.onKeyDown?.(event); }}
    onContextMenu={event => { onContextMenu?.(event); if (!event.defaultPrevented) touch.onContextMenu?.(event); }}
  />;
});

export { Root as DropdownMenu, Trigger as DropdownMenuTrigger };
