import React, { forwardRef, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import {
  defaultButtonSize, defaultButtonVariant,
  type ButtonSize, type ButtonVariant, type ButtonContentLayout, type ControlSurface,
} from "@opencraft/design-system/button";
import { LoadingRingIcon } from "./action-icons";
import { LiquidGlassBackdrop } from "./liquid-glass";
import { useTouchPress } from "./use-touch-press";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly children: ReactNode;
  readonly loading?: boolean;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly density?: "default" | "compact";
  readonly surface?: ControlSurface;
  /** Solid floating controls protect text contrast without compositor backdrop readiness. */
  readonly surfaceMaterial?: "glass" | "solid";
  readonly contentLayout?: ButtonContentLayout;
}

/** Stable DOM and focus across visual changes; operation state stays with callers. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children, className, disabled = false, loading = false, density = "default",
  size = defaultButtonSize, variant = defaultButtonVariant, surface = "integrated",
  surfaceMaterial = "glass",
  contentLayout = "label", type = "button", ...props
}, ref) {
  return <button {...props} ref={ref} type={type}
    className={["ui-button", className].filter(Boolean).join(" ")}
    data-size={size} data-density={density} data-variant={variant}
    data-control-surface={surface} data-content-layout={contentLayout}
    data-control-loading={loading || undefined}
    aria-busy={loading || props["aria-busy"]} disabled={disabled || loading}>
    <LiquidGlassBackdrop active={surface === "floating"} material={surfaceMaterial} />
    {loading ? <LoadingRingIcon size={14} className="ui-button__spinner" aria-hidden="true" /> : null}
    {contentLayout === "row" ? children : <span className="ui-button__label">{children}</span>}
  </button>;
});

export interface IconButtonProps extends Omit<ButtonProps, "contentLayout"> {
  readonly "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  size = "chrome", variant = "ghost", ...props
}, ref) {
  return <Button {...props} ref={ref} size={size} variant={variant} contentLayout="icon" />;
});

/** A text action inside a sentence inherits its reading role and can wrap. */
export const InlineAction = forwardRef<HTMLButtonElement, Omit<ButtonProps, "variant" | "size" | "density" | "surface" | "contentLayout">>(
  function InlineAction({ className, ...props }, ref) {
    return <Button {...props} ref={ref} variant="link" size="sm" contentLayout="row"
      className={["ui-inline-action", className].filter(Boolean).join(" ")} />;
  },
);

export type DisclosureButtonProps = Omit<ButtonProps, "variant" | "surface" | "contentLayout">;

/** Menu/popover owners supply open state; every quiet disclosure shares feedback. */
export const DisclosureButton = forwardRef<HTMLButtonElement, DisclosureButtonProps>(function DisclosureButton({
  size = "accessory", className, ...props
}, ref) {
  return <Button {...props} ref={ref} className={["ui-disclosure-button", className].filter(Boolean).join(" ")}
    size={size} variant="ghost" surface="integrated" contentLayout="row" />;
});

/** Non-interactive measurement twin consumes the same geometry as the real action. */
export const ButtonPlaceholder = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & {
  size?: ButtonSize; contentLayout?: ButtonContentLayout;
}>(function ButtonPlaceholder({ className, size = "chrome", contentLayout = "icon", children, ...props }, ref) {
  return <span {...props} ref={ref} aria-hidden="true" className={["ui-button", className].filter(Boolean).join(" ")}
    data-size={size} data-density="default" data-variant="ghost"
    data-content-layout={contentLayout} data-control-surface="integrated">{children}</span>;
});

/** One native action for a quiet collection row; content never owns a second target. */
export const ObjectRowButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "variant" | "surface" | "size" | "contentLayout" | "density">>(
  function ObjectRowButton({ className, onPointerDown, onKeyDown, ...props }, ref) {
    const press = useTouchPress(Boolean(props.disabled || props.loading));
    return <Button {...props} {...press} ref={ref}
      onPointerDown={event => { onPointerDown?.(event); press.onPointerDown(event); }}
      onKeyDown={event => { press.onKeyDown(); onKeyDown?.(event); }} className={["ui-object-row-button", className].filter(Boolean).join(" ")}
      variant="ghost" surface="integrated" size="md" contentLayout="row" />;
  },
);

/** A readable object heading that opens its existing detail surface. */
export const ObjectTitleButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "variant" | "surface" | "size" | "contentLayout" | "density"> & { prominence?: "default" | "reading" | "preview" }>(
  function ObjectTitleButton({ className, onClick, children, prominence = "default", ...props }, ref) {
    return <Button {...props} ref={ref} variant="link" size="sm" contentLayout="row"
      data-object-prominence={prominence} className={["ui-object-title-button", className].filter(Boolean).join(" ")}
      onClick={event => {
        const selection = window.getSelection();
        if (event.detail > 0 && selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
        event.currentTarget.focus({ preventScroll: true });
        onClick?.(event);
      }}>{children}</Button>;
  },
);

/** Expands an object's native title action to its surface without nesting controls. */
export function ObjectActionSurface({ children, className, disabled = false, onOpen, ...props }: Omit<HTMLAttributes<HTMLDivElement>, "onClick"> & {
  disabled?: boolean; onOpen(): void;
}) {
  const scrollStart = useRef<{ pointerId: number; node: Element; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  return <div {...props} className={["ui-object-action-surface", className].filter(Boolean).join(" ")}
    data-action-disabled={disabled || undefined}
    onPointerDown={event => { props.onPointerDown?.(event); const node = event.target instanceof Element ? event.target.closest('[data-object-scroll]') : null; scrollStart.current = node ? { pointerId: event.pointerId, node, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, moved: false } : null; }}
    onPointerMove={event => { const start = scrollStart.current; if (start?.pointerId !== event.pointerId) return; props.onPointerMove?.(event); if (start && (Math.abs(event.clientX - start.x) > 6 || Math.abs(event.clientY - start.y) > 6)) start.moved = true; }}
    onPointerCancel={event => { scrollStart.current = null; props.onPointerCancel?.(event); }}
    onClickCapture={event => { props.onClickCapture?.(event); const start = scrollStart.current; if (event.detail > 0 && start && (start.moved || start.node.scrollLeft !== start.left || start.node.scrollTop !== start.top)) { event.preventDefault(); event.stopPropagation(); } scrollStart.current = null; }}
    onClick={event => {
      const target = event.target;
      if (disabled || !(target instanceof Element) || target.closest("button,a,input,textarea,select,[role=button],[role=menuitem],[contenteditable=true]")) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return;
      const title = event.currentTarget.querySelector<HTMLButtonElement>(".ui-object-title-button");
      if (!title || title.disabled) return;
      title.focus({ preventScroll: true });
      onOpen();
    }}>{children}</div>;
}
