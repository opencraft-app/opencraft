import { ArrowUpIcon } from "@opencraft/design-system-web/action-icons";
import * as React from "react";

export interface ScrollToBottomButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly show: boolean;
  readonly showWorkingDots?: boolean;
}

export function ScrollToBottomButton({
  label,
  onClick,
  show,
  showWorkingDots = false,
}: ScrollToBottomButtonProps) {
  return (
    <button
      aria-hidden={!show}
      aria-label={label}
      className="thread-scroll-to-bottom-button"
      data-visible={show}
      onClick={show ? onClick : undefined}
      tabIndex={show ? 0 : -1}
      type="button"
    >
      {showWorkingDots ? (
        <span aria-hidden="true" className="thread-scroll-to-bottom-button__working">
          <i className="thread-scroll-to-bottom-button__dot" />
          <i className="thread-scroll-to-bottom-button__dot" />
          <i className="thread-scroll-to-bottom-button__dot" />
        </span>
      ) : <ArrowUpIcon size={20} strokeWidth={2} className="thread-scroll-to-bottom-button__icon" />}
    </button>
  );
}
