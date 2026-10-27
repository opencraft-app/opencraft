import React, { type SVGProps } from "react";

export function TaskLinkIcon({ size = 24, strokeWidth = 1.75, ...props }: SVGProps<SVGSVGElement> & { readonly size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true" data-action-glyph="task-link" {...props}><path d="M9.5 14.5a4 4 0 0 0 5.66 0l3.34-3.34a4 4 0 0 0-5.66-5.66L11.5 6.84" /><path d="M14.5 9.5a4 4 0 0 0-5.66 0L5.5 12.84a4 4 0 0 0 5.66 5.66l1.34-1.34" /></svg>;
}
