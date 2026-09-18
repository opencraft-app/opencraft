import { useEffect, useRef, useState } from "react";

import {
  advanceInternalDeveloperModeGesture,
  EMPTY_ESCAPE_SEQUENCE,
  toggleInternalDeveloperMode,
  type EscapeSequenceState,
} from "../internal-developer-mode";

/**
 * The Workbench root is the sole owner of the hidden developer-mode gesture.
 * It deliberately does not cancel Escape, so normal dialogs and panels retain
 * their existing keyboard behavior while the sequence is observed.
 */
export function InternalDeveloperModeGate() {
  const sequenceRef = useRef<EscapeSequenceState>(EMPTY_ESCAPE_SEQUENCE);
  const [announcing, setAnnouncing] = useState<"enabled" | "disabled" | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const result = advanceInternalDeveloperModeGesture(sequenceRef.current, {
        key: event.key,
        repeat: event.repeat,
        now: performance.now(),
      });
      sequenceRef.current = result.state;
      if (!result.unlocked) return;

      const state = toggleInternalDeveloperMode();
      console.info(`[internal-developer-mode] ${state} for this browser session`);
      setAnnouncing(state);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    if (announcing === null) return undefined;
    const timer = window.setTimeout(() => setAnnouncing(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [announcing]);

  return announcing !== null ? (
    <div className="internal-developer-mode-notice" role="status" aria-live="polite">
      Internal developer mode {announcing}
    </div>
  ) : null;
}
