import type { ReactNode, SyntheticEvent } from "react";
import { ChevronDownIcon } from "@opencraft/design-system-web/action-icons";
import "./details.scss";

/** Optional configuration stays keyboard-accessible without replacing draft nodes. */
export function AssetDetails({
  label,
  children,
  open,
  onOpenChange,
}: {
  label: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <details
      className="asset-details"
      open={open}
      onToggle={
        onOpenChange ? (event: SyntheticEvent<HTMLDetailsElement>) => onOpenChange(event.currentTarget.open) : undefined
      }
    >
      <summary>
        <span>{label}</span>
        <ChevronDownIcon />
      </summary>
      <div className="asset-details__body">{children}</div>
    </details>
  );
}
