import React, { useId } from "react";
import { motion } from "motion/react";

/** Timeline data indicators retain their established slots and interpolation. */
export function TimelineProgressIcon({ completed, total, reducedMotion }: {
  readonly completed: number;
  readonly total: number;
  readonly reducedMotion: boolean;
}) {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" data-action-glyph="timeline-progress">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
    <motion.circle cx="8" cy="8" r="6" pathLength="1" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="1"
      initial={{ strokeDashoffset: 1 }} animate={{ strokeDashoffset: total > 0 ? 1 - completed / total : 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.3 }} transform="rotate(-90 8 8)" />
  </svg>;
}

export function TimelineStatusIcon({ status }: { readonly status: "pending" | "in-progress" | "complete" }) {
  const gradientId = useId();
  if (status === "complete") return <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14" data-action-glyph="timeline-complete">
    <circle cx="7" cy="7" fill="none" r="6.4" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3.4 7.2 5.8 9.4 10.7 4.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
  </svg>;
  if (status === "in-progress") return <svg aria-hidden="true" className="thread-todo__progress-glyph" height="14" viewBox="0 0 14 14" width="14" data-action-glyph="timeline-active">
    <defs><linearGradient id={gradientId} x1="2.5" x2="10.5" y1="12" y2="3.5"><stop stopColor="currentColor" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
    <circle cx="7" cy="7" fill="none" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
  </svg>;
  return <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14" data-action-glyph="timeline-pending">
    <circle cx="7" cy="7" fill="none" r="6.4" stroke="currentColor" strokeDasharray="2.4 2.4" strokeWidth="1.2" />
  </svg>;
}
