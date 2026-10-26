import * as Primitive from "@radix-ui/react-context-menu";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { forwardRef, useContext, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { MenuInteraction, MenuDismissSurface } from "./menu-interaction";

export * from "@radix-ui/react-context-menu";

export type ContextMenuProps = Omit<ComponentPropsWithoutRef<typeof Primitive.Root>, "modal">;

export function Root({ open: controlled, onOpenChange, children, ...props }: ContextMenuProps) {
  const [local, setLocal] = useState(false);
  const open = controlled ?? local;
  const change = (next: boolean) => {
    if (controlled === undefined) setLocal(next);
    onOpenChange?.(next);
  };
  // Same contact contract as DropdownMenu; no independent document lock.
  return <Primitive.Root {...props} modal={false} open={open} onOpenChange={change}>
    <MenuInteraction.Provider value={{ open, change }}>{children}</MenuInteraction.Provider>
  </Primitive.Root>;
}

/** The release that opened a touch context menu still belongs to its trigger.
 * Consume its compatibility click centrally, rather than relying on every row
 * to recognize PointerEvent vs MouseEvent or to suppress navigation itself. */
export const Trigger = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<typeof Primitive.Trigger>>(function Trigger(
  { onPointerDown, onClickCapture, ...props }, ref,
) {
  const menu = useContext(MenuInteraction);
  const touch = useRef(false);
  return <Primitive.Trigger {...props} ref={ref}
    onPointerDown={event => {
      touch.current = event.pointerType === "touch" || event.pointerType === "pen";
      onPointerDown?.(event);
    }}
    onClickCapture={event => {
      onClickCapture?.(event);
      if (menu?.open && touch.current) {
        event.preventDefault(); event.stopPropagation();
      }
    }}
  />;
});

export const Content = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Primitive.Content>>(function Content(props, ref) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const composedRef = useComposedRefs(ref, setContent);
  return <>
    <MenuDismissSurface content={content} />
    <Primitive.Content {...props} ref={composedRef} />
  </>;
});

export { Root as ContextMenu, Trigger as ContextMenuTrigger, Content as ContextMenuContent };
