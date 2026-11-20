import { forwardRef } from "react";
import { Button, type ButtonProps } from "@opencraft/design-system-web/button";

/** One Shell navigation treatment; callers own action, state and icon/row content. */
export const ShellNavigationButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "size" | "variant" | "surfaceMaterial">>(
  function ShellNavigationButton(props, ref) {
    return <Button {...props} ref={ref} size="navigation" variant="ghost" surfaceMaterial="solid" />;
  },
);
