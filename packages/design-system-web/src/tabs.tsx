import { Button } from "./button";
import { useId, type ReactNode } from "react";

export function Tabs({ label, value, options, onValueChange, className }: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: ReactNode; readonly panelId: string }[];
  readonly onValueChange: (value: string) => void;
  readonly className?: string;
}) {
  const id = useId();
  return <div role="tablist" aria-label={label} className={["ui-tabs", className].filter(Boolean).join(" ")} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const previous = event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (previous ? -1 : 1) + items.length) % items.length;
    items[next]!.focus(); onValueChange(options[next]!.value);
  }}>
    {options.map(option => <Button key={option.value} id={`${id}-${option.value}`} role="tab" aria-selected={value === option.value}
      aria-controls={option.panelId} tabIndex={value === option.value ? 0 : -1} variant={value === option.value ? "secondary" : "ghost"}
      size="sm" onClick={() => onValueChange(option.value)}>{option.label}</Button>)}
  </div>;
}
