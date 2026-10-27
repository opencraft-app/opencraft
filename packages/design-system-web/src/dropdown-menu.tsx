import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { forwardRef, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type PointerEventHandler } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { MenuInteraction as Activation, MenuDismissSurface } from "./menu-interaction";
import { useTouchMenuTrigger } from "./use-touch-menu-trigger";

// Radix retains menu semantics, focus, keyboard and nested portals. Shared
// content consumes outside contacts independently of the root focus modality.
export * from "@radix-ui/react-dropdown-menu";

export type DropdownMenuProps = Omit<ComponentPropsWithoutRef<typeof Primitive.Root>, "modal"> & {
  /** Native system surfaces may temporarily take window focus without an outside contact. */
  dismissOnWindowBlur?: boolean;
};

export function Root({ open: controlled, defaultOpen = false, onOpenChange, dismissOnWindowBlur = true, children, ...props }: DropdownMenuProps) {
  const [local, setLocal] = useState(defaultOpen);
  const open = controlled ?? local;
  const windowBlur = useRef<Event | null>(null);
  useLayoutEffect(() => {
    if (!open || dismissOnWindowBlur) return;
    const captureBlur = (event: Event) => {
      if (event.target === window) windowBlur.current = event;
    };
    // Install before Radix's passive blur listener, including at the Window target.
    window.addEventListener("blur", captureBlur, true);
    return () => {
      window.removeEventListener("blur", captureBlur, true);
      windowBlur.current = null;
    };
  }, [open, dismissOnWindowBlur]);
  const change = (next: boolean) => {
    // Radix does not expose a cancellable window-blur dismissal event. Its
    // close callback runs synchronously inside that dispatch. currentTarget
    // resets afterwards, so later clicks/Escape still close even in this task.
    if (!next && !dismissOnWindowBlur && windowBlur.current?.currentTarget === window) return;
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  // Pointer isolation belongs to Content's dismiss surface. A document-wide
  // modal focus/pointer lock would also exclude an editor retaining focus.
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

export const Content = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Primitive.Content>>(function Content(props, ref) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const composedRef = useComposedRefs(ref, setContent);
  return <>
    <MenuDismissSurface content={content} />
    <Primitive.Content {...props} ref={composedRef} />
  </>;
});

export { Root as DropdownMenu, Trigger as DropdownMenuTrigger, Content as DropdownMenuContent };
