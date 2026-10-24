import React, { type CSSProperties } from "react";

/** Container-sized recovery paint; the consumer owns geometry, activity and motion. */
export function RecoveryScanArtwork({ className, beamClassName }: { readonly className: string; readonly beamClassName: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      {[22, 18, 14, 10, 6, 2].map((length, index) => <rect
        key={length}
        x="0.5" y="0.5"
        pathLength={100}
        className={beamClassName}
        strokeDasharray={`${length} ${100 - length}`}
        strokeWidth={0.3 + index * 0.16}
        opacity={0.14 + index * 0.025}
        style={{ "--scan-offset": `${length / 2}px` } as CSSProperties}
      />)}
    </svg>
  );
}
