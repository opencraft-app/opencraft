import * as Primitive from "@radix-ui/react-context-menu";
import { forwardRef, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { MenuInteraction } from "./menu-interaction";

export * from "@radix-ui/react-context-menu";

export type ContextMenuProps = Omit<ComponentPropsWithoutRef<typeof Primitive.Root>, "modal">;

export function Root({ open: controlled, onOpenChange, children, ...props }: ContextMenuProps) {
  const [local, setLocal] = useState(false);
  const open = controlled ?? local;
  const change = (next: boolean) => {
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  // Native outside dismissal, matching DropdownMenu without a page-wide blocker.
  return <Primitive.Root {...props} modal={false} open={open} onOpenChange={change}>
    <MenuInteraction.Provider value={{ open, change }}>{children}</MenuInteraction.Provider>
  </Primitive.Root>;
}

/** The release that opened a touch context menu still belongs to its trigger.
 * Consume its compatibility click centrally, rather than relying on every row
 * to recognize PointerEvent vs MouseEvent or to suppress navigation itself. */
export const Trigger = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<typeof Primitive.Trigger>>(function Trigger(
  { onPointerDown, onPointerUp, onPointerCancel, onMouseDown, onClickCapture, ...props }, ref,
) {
  const menu = useContext(MenuInteraction);
  const touching = useRef(false);
  const openingClick = useRef(false);
  useLayoutEffect(() => {
    if (menu?.open && touching.current) openingClick.current = true;
  }, [menu?.open]);
  return <Primitive.Trigger {...props} ref={ref}
    onPointerDown={event => {
      openingClick.current = false;
      touching.current = event.pointerType === "touch" || event.pointerType === "pen";
      onPointerDown?.(event);
    }}
    onPointerUp={event => { touching.current = false; onPointerUp?.(event); }}
    onPointerCancel={event => {
      touching.current = false;
      openingClick.current = false;
      onPointerCancel?.(event);
    }}
    onMouseDown={event => {
      onMouseDown?.(event);
      // The compatibility mousedown of the opening hold must not focus its row
      // and dismiss the freshly opened menu before the corresponding click.
      if (openingClick.current) event.preventDefault();
    }}
    onClickCapture={event => {
      onClickCapture?.(event);
      if (openingClick.current) {
        openingClick.current = false;
        event.preventDefault(); event.stopPropagation();
      }
    }}
  />;
});

export const Content = Primitive.Content;

export { Root as ContextMenu, Trigger as ContextMenuTrigger, Content as ContextMenuContent };
