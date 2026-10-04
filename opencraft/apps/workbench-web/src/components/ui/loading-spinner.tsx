import React from "react";

/** Decorative only. The consuming resource view owns pending state and its name. */
export function LoadingSpinner() {
  return (
    <svg className="workbench-loading-spinner" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M12 4a8 8 0 1 1-8 8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
