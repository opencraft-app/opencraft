import React, { type ReactNode } from "react";

/** The label is presentation; one stable native button owns mouse, touch and keyboard activation. */
export function OverlayDisclosureTrigger({
  buttonClassName,
  children,
  className,
  contentClassName,
  interactive = true,
  labelId,
  onToggle,
  open,
  reflowOwned = false,
}: {
  readonly buttonClassName?: string;
  readonly children: ReactNode;
  readonly className: string;
  readonly contentClassName: string;
  readonly interactive?: boolean;
  readonly labelId: string;
  readonly onToggle: (anchor: HTMLButtonElement) => void;
  readonly open: boolean;
  readonly reflowOwned?: boolean;
}) {
  return (
    <div className={`overlay-disclosure-trigger ${className}`} data-interactive={interactive || undefined}>
      {interactive ? (
        <button
          aria-expanded={open}
          aria-labelledby={labelId}
          className={`overlay-disclosure-trigger__hit-target ${buttonClassName ?? ""}`.trim()}
          data-timeline-reflow-owned={reflowOwned || undefined}
          onClick={(event) => onToggle(event.currentTarget)}
          type="button"
        />
      ) : null}
      <span className={`overlay-disclosure-trigger__content ${contentClassName}`}>{children}</span>
    </div>
  );
}
