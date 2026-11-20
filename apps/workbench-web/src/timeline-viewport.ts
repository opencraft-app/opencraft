import { createWebTimelineViewportPort, resolveWebTimelinePlatform } from "@opencraft/timeline-host-web";
import { resolveTimelineViewportPolicy, type TimelineViewportPolicy } from "@opencraft/timeline-virtualizer";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { getLocalDiagnosticsState, subscribeLocalDiagnostics } from "./runtime/local-diagnostics";
import { useOptionalUiPreferencesRuntime } from "./runtime/ui-preferences-runtime";

import type { WindowChromeSnapshot } from "./window-chrome";

/**
 * Binds the renderer-neutral timeline viewport port to the current Web shell.
 * Expo Native owns a different adapter; Expo Web may reuse this package-level
 * Web adapter without importing the Vite shell.
 */
export function useTimelineViewportHost(windowChrome: WindowChromeSnapshot): TimelineViewportPolicy {
  const preferences = useOptionalUiPreferencesRuntime();
  const clearance = useSyncExternalStore(preferences?.subscribe ?? noSubscribe,
    () => preferences?.get("interface.keyboardClearance") ?? false, () => false);
  useLayoutEffect(() => {
    document.documentElement.dataset.keyboardClearance = String(clearance);
    return () => { delete document.documentElement.dataset.keyboardClearance; };
  }, [clearance]);
  const policy = useMemo(() => {
    const detectedPlatform = resolveWebTimelinePlatform({
      maxTouchPoints: navigator.maxTouchPoints,
      navigatorPlatform: navigator.platform,
      userAgent: navigator.userAgent,
    });
    return resolveTimelineViewportPolicy({
      kind: windowChrome.kind,
      platform: detectedPlatform === "ios" || detectedPlatform === "android"
        ? detectedPlatform
        : windowChrome.platform,
    });
  }, [windowChrome.kind, windowChrome.platform]);

  useLayoutEffect(() => {
    let disposed = false;
    let observe: ((event?: Event) => void) | undefined;
    const port = createWebTimelineViewportPort(window, document, {
      kind: windowChrome.kind,
      platform: windowChrome.platform,
      onGeometryObserved: policy.tracksVisualViewport ? event => observe?.(event) : undefined,
    });
    // Layout starts synchronously. Evidence collection is mobile-only and can
    // load independently without putting the export/probe code on startup.
    const updateDiagnostics = () => {
      observe = undefined;
      const session = getLocalDiagnosticsState();
      if (!session.enabled || !policy.tracksVisualViewport) return;
      void import("./runtime/viewport-diagnostics").then(({ createViewportDiagnostics }) => {
        if (disposed || getLocalDiagnosticsState() !== session) return;
        observe = createViewportDiagnostics(); observe();
      }).catch(() => {});
    };
    const stop = subscribeLocalDiagnostics(updateDiagnostics);
    updateDiagnostics();
    return () => { disposed = true; stop(); observe = undefined; port.dispose(); };
  }, [windowChrome.kind, windowChrome.platform, policy.tracksVisualViewport]);

  return policy;
}

const noSubscribe = () => () => {};
