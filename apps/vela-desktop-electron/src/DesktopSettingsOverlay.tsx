import React from "react";
import { ServerCog, X } from "lucide-react";

export interface DesktopSettingsOverlayProps {
  apiBaseUrl: string;
  hostLabel: string;
  sessionsCount: number;
  onClose: () => void;
}

export function DesktopSettingsOverlay({
  apiBaseUrl,
  hostLabel,
  sessionsCount,
  onClose,
}: DesktopSettingsOverlayProps) {
  return (
    <div className="vela-desktop-settings-overlay" role="presentation">
      <section
        className="settings-panel macos-popover-surface"
        aria-label="Desktop settings"
        role="dialog"
      >
        <div className="settings-panel-header">
          <div>
            <div className="settings-title">Desktop settings</div>
            <div className="settings-subtitle">Vela shell host</div>
          </div>
          <button
            className="settings-close-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="settings-grid">
          <div className="settings-diagnostic">
            <span>Host</span>
            <strong>
              <ServerCog size={15} aria-hidden />
              {hostLabel}
            </strong>
          </div>
          <div className="settings-diagnostic">
            <span>velad API</span>
            <strong>{apiBaseUrl}</strong>
          </div>
          <div className="settings-diagnostic">
            <span>Session cache</span>
            <strong>{sessionsCount} sessions</strong>
          </div>
        </div>
      </section>
    </div>
  );
}
