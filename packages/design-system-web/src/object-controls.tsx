import React, { forwardRef } from "react";
import { Button, type ButtonProps } from "./button";

/** A native whole-card action with rich, non-interactive content slots.
 * Ref/event/disabled semantics remain Button-owned (including Dialog asChild). */
export const ObjectCardButton = forwardRef<HTMLButtonElement,
  Omit<ButtonProps, "variant" | "size" | "surface" | "contentLayout" | "density">
>(function ObjectCardButton({ className, ...props }, ref) {
  return <Button {...props} ref={ref} variant="ghost" size="md" surface="integrated" contentLayout="row"
    className={["ui-object-card-button", className].filter(Boolean).join(" ")} />;
});


/** Intrinsic media action. Content owns the thumbnail/placeholder dimensions;
 * the shared control owns zero-chrome geometry, hit target and action cursor. */
export const MediaActionButton = forwardRef<HTMLButtonElement,
  Omit<ButtonProps, "variant" | "size" | "surface" | "contentLayout" | "density"> & {
    readonly action?: "preview" | "retry";
  }
>(function MediaActionButton({ className, action = "preview", ...props }, ref) {
  return <Button {...props} ref={ref} variant="ghost" size="md" surface="integrated" contentLayout="row"
    data-media-action={action} className={["ui-media-action-button", className].filter(Boolean).join(" ")} />;
});
