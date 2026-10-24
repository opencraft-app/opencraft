import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";

import {
  advanceInternalDeveloperModeGesture,
  advanceInternalDeveloperModeTitleTaps,
  consumeInternalDeveloperModeQuery,
  EMPTY_ESCAPE_SEQUENCE,
  EMPTY_TITLE_TAP_SEQUENCE,
  subscribeInternalDeveloperMode,
  takeInternalDeveloperModeAnnouncement,
  toggleInternalDeveloperMode,
  useInternalDeveloperMode,
  type EscapeSequenceState,
  type TitleTapSequenceState,
} from "../internal-developer-mode";
const InternalDeveloperDiagnostics = lazy(async () => {
  const module = await import("./internal-developer-diagnostics");
  return { default: module.InternalDeveloperDiagnostics };
});

const TITLE_TAP_SELECTOR = [
  ".settings-page__navigation-heading",
  ".settings-control-page-header h2",
  "[data-internal-developer-title]",
].join(", ");

/**
 * The Workbench root is the sole owner of the hidden developer-mode gesture.
 * It deliberately does not cancel Escape, so normal dialogs and panels retain
 * their existing keyboard behavior while the sequence is observed.
 */
export function InternalDeveloperModeGate() {
  const sequenceRef = useRef<EscapeSequenceState>(EMPTY_ESCAPE_SEQUENCE);
  const titleTapsRef = useRef<TitleTapSequenceState>(EMPTY_TITLE_TAP_SEQUENCE);
  const [announcing, setAnnouncing] = useState<"enabled" | "disabled" | null>(null);
  const enabled = useInternalDeveloperMode();
  const intl = useIntl();

  useEffect(() => {
    consumeInternalDeveloperModeQuery();
    const announced = takeInternalDeveloperModeAnnouncement();
    if (announced) setAnnouncing(announced);
    return subscribeInternalDeveloperMode(() => {
      const next = takeInternalDeveloperModeAnnouncement();
      if (next) setAnnouncing(next);
    });
  }, []);

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
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(TITLE_TAP_SELECTOR)) return;
      const result = advanceInternalDeveloperModeTitleTaps(titleTapsRef.current, performance.now());
      titleTapsRef.current = result.state;
      if (!result.toggled) return;
      const state = toggleInternalDeveloperMode();
      console.info(`[internal-developer-mode] ${state} for this browser session`);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, []);

  useEffect(() => {
    if (announcing === null) return undefined;
    const timer = window.setTimeout(() => setAnnouncing(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [announcing]);

  return (
    <>
      {announcing !== null ? (
        <div className="internal-developer-mode-notice" role="status" aria-live="polite">
          {announcing === "enabled"
            ? intl.formatMessage({ id: "developerMode.enabled", defaultMessage: "Internal developer mode enabled" })
            : intl.formatMessage({ id: "developerMode.disabled", defaultMessage: "Internal developer mode disabled" })}
        </div>
      ) : null}
      {enabled ? (
        <Suspense fallback={null}>
          <InternalDeveloperDiagnostics />
        </Suspense>
      ) : null}
    </>
  );
}
