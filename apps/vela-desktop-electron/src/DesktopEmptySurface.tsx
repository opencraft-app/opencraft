import React from "react";

export function DesktopEmptySurface({ error }: { error?: string | null }) {
  if (error) {
    return (
      <div className="vela-desktop-empty" role="status">
        <p>{error}</p>
      </div>
    );
  }

  return <div className="vela-desktop-empty" aria-hidden="true" />;
}
