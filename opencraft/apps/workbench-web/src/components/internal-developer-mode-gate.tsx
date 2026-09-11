import { useEffect, useRef, useState } from "react";

import {
  advanceInternalDeveloperModeGesture,
  EMPTY_ESCAPE_SEQUENCE,
  enableInternalDeveloperMode,
  useInternalDeveloperMode,
  type EscapeSequenceState,
} from "../internal-developer-mode";

/**
 * The Workbench root is the sole owner of the hidden developer-mode gesture.
 * It deliberately does not cancel Escape, so normal dialogs and panels retain
 * their existing keyboard behavior while the sequence is observed.
 */
export function InternalDeveloperModeGate() {
  const enabled = useInternalDeveloperMode();
  const sequenceRef = useRef<EscapeSequenceState>(EMPTY_ESCAPE_SEQUENCE);
  const [announcing, setAnnouncing] = useState(false);

  useEffect(() => {
    if (enabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      const result = advanceInternalDeveloperModeGesture(sequenceRef.current, {
        key: event.key,
        repeat: event.repeat,
        now: performance.now(),
      });
      sequenceRef.current = result.state;
      if (!result.unlocked || !enableInternalDeveloperMode()) return;

      console.info("[internal-developer-mode] enabled for this browser session");
      setAnnouncing(true);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled]);

  useEffect(() => {
    if (!announcing) return undefined;
    const timer = window.setTimeout(() => setAnnouncing(false), 2_400);
    return () => window.clearTimeout(timer);
  }, [announcing]);

  return announcing ? (
    <div className="internal-developer-mode-notice" role="status" aria-live="polite">
      Internal developer mode enabled
    </div>
  ) : null;
}
