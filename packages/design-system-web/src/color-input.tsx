import { forwardRef, type InputHTMLAttributes } from "react";
import "./color-input.web.scss";

/** Native color selection with shared control geometry, focus and touch density. */
export const ColorInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function ColorInput({ className, ...props }, ref) {
  return <input {...props} ref={ref} type="color" className={["ui-color-input", className].filter(Boolean).join(" ")} />;
});
