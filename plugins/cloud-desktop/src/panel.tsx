import { LoadingRingIcon } from "@opencraft/design-system-web/action-icons";
/// <reference path="./styles.d.ts" />
import "./panel.web.scss";
import type { CloudDesktopPluginAdapter } from "./index";
import React from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { PasteIcon as ClipboardPaste, KeyboardIcon as Keyboard, MonitorOffIcon as MonitorOff } from "@opencraft/design-system-web/action-icons";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import type { DesktopBackend } from "./contract";
import { DesktopViewController, type DesktopViewSnapshot } from "./controller";
import type { DesktopSurfaceFactory } from "./viewer";
import { useDesktopControlAction } from "./control-action";
import { bindDesktopInteractionOwner, ownsDesktopFocus } from "./interaction-owner";

export function createDesktopPanel(adapter: CloudDesktopPluginAdapter | undefined,
  controllers: Map<DesktopViewController, string>) {
  return function DesktopPanel({ tab, ownerId, active = true }: PanelRendererProps) {
    const intl = useIntl();
    const panel = useRef<HTMLElement>(null);
    const element = useRef<HTMLDivElement>(null);
    const trackpad = useRef<HTMLDivElement>(null);
    const controller = useRef<DesktopViewController | null>(null);
    const [snapshot, setSnapshot] = useState<DesktopViewSnapshot>(() => {
      // A cached capability is a presentation hint, not authorization. Avoid
      // painting an unavailable frame before the real controller starts.
      let available = false;
      try { available = Boolean(tab.resource && adapter?.backend.resolveTarget(tab.resource)?.conversationId === tab.resource); }
      catch { /* The controller will resolve unavailable without bootstrap. */ }
      return { phase: available ? "connecting" : "unavailable", control: "observing",
        canControl: false, controlFailed: false };
    });
    const controlAction = useDesktopControlAction(controller, snapshot.control === "observing" ? "take" : "stop");
    const surfaceAction = useDesktopControlAction<HTMLDivElement>(controller, "take", true);
    /** A read-only lease keeps the action clickable. One click = one takeover
     * reconnect (the provider owns preemption); never a timed polling loop.
     * The intent lives only for that reconnected viewer and only while the
     * user stays on this panel: focus leaving, an outside interaction or
     * window deactivation cancels it, so a late grant can never pull the user
     * back from another task. */
    const takeoverRef = useRef<(() => void) | null>(null);
    const requestTakeover = useCallback(() => {
      const current = controller.current;
      const owner = panel.current;
      if (!active || !current || !owner || !adapter?.backend.requestTakeover || current.getSnapshot().phase !== "ready") return;
      takeoverRef.current?.();
      // Keep the explicit gesture on a stable owner while the reconnect hides
      // the toolbar. This runs now, never when a delayed grant arrives.
      owner.focus({ preventScroll: true });
      let stage: "reconnecting" | "connecting" | "ready" = "reconnecting";
      const stop = (): void => { takeoverRef.current = null; unsubscribe(); disposeLeave(); };
      const unsubscribe = current.subscribe(() => {
        const state = current.getSnapshot();
        if (state.phase === "failed" || state.phase === "unavailable") { stop(); return; }
        if (state.phase !== "ready") {
          if (stage === "ready") stop(); else stage = "connecting";
          return;
        }
        if (stage === "reconnecting") return;
        stage = "ready";
        if (state.control === "observing" && state.canControl) {
          stop();
          // The reconnect grant is late evidence, not fresh intent: only take
          // control when this panel still owns focus at that moment.
          if (ownsDesktopFocus(owner)) void current.requestControl();
        }
      });
      const disposeLeave = bindDesktopInteractionOwner(owner, stop);
      takeoverRef.current = stop;
      adapter.backend.requestTakeover();
      current.retry();
    }, [active]);
    const owned = active && snapshot.phase === "ready" && snapshot.control === "controlling";
    const ratio = snapshot.mediaAspectRatio;
    const geometry = { "--desktop-aspect-ratio": ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3 } as CSSProperties;
    const controlLabels = {
      observing: intl.formatMessage({ id: "desktop.control", defaultMessage: "Take control" }),
      requesting: intl.formatMessage({ id: "desktop.release", defaultMessage: "Stop controlling" }),
      controlling: intl.formatMessage({ id: "desktop.release", defaultMessage: "Stop controlling" }),
    };
    useEffect(() => {
      if (!adapter || !tab.resource || !element.current || !panel.current) return;
      const owner = panel.current;
      const current = new DesktopViewController(adapter.backend, adapter.surfaces, tab.resource, element.current,
        undefined, undefined, () => ownsDesktopFocus(owner));
      controller.current = current;
      controllers.set(current, ownerId);
      current.setActive(active);
      const unsubscribe = current.subscribe(() => setSnapshot(current.getSnapshot()));
      const disposeInteraction = bindDesktopInteractionOwner(owner, () => current.releaseControl());
      current.start();
      setSnapshot(current.getSnapshot());
      return () => {
        takeoverRef.current?.();
        unsubscribe();
        disposeInteraction();
        controller.current = null;
        controllers.delete(current);
        current.dispose();
      };
    }, [tab.resource, ownerId]);
    useLayoutEffect(() => {
      if (!active) takeoverRef.current?.();
      controller.current?.setActive(active);
    }, [active]);

    useEffect(() => {
      if (trackpad.current && snapshot.trackpadAvailable) return controller.current?.attachTrackpad(trackpad.current);
    }, [snapshot.trackpadAvailable, tab.resource, ownerId]);

    const status = snapshot.phase === "unavailable"
      ? intl.formatMessage({ id: "desktop.unavailable", defaultMessage: "Desktop is not available here." })
      : snapshot.phase === "failed"
        ? snapshot.failure === "authorization" || snapshot.failure === "identity"
          ? intl.formatMessage({ id: "desktop.accessFailed", defaultMessage: "Desktop access has changed." })
          : snapshot.stage === "preparing"
            ? intl.formatMessage({ id: "desktop.prepareFailed", defaultMessage: "Unable to start the desktop." })
            : snapshot.stage === "video"
              ? intl.formatMessage({ id: "desktop.videoFailed", defaultMessage: "Unable to load the desktop view." })
              : snapshot.stage === "connected"
                ? intl.formatMessage({ id: "desktop.disconnected", defaultMessage: "Desktop disconnected." })
                : intl.formatMessage({ id: "desktop.connectFailed", defaultMessage: "Unable to connect to the desktop." })
        : snapshot.phase === "connecting"
          ? snapshot.stage === "preparing"
            ? intl.formatMessage({ id: "desktop.preparing", defaultMessage: "Starting desktop…" })
            : snapshot.stage === "video"
              ? intl.formatMessage({ id: "desktop.loading", defaultMessage: "Loading desktop…" })
              : intl.formatMessage({ id: "desktop.connecting", defaultMessage: "Connecting…" })
          : snapshot.clipboardBusy
            ? intl.formatMessage({ id: "desktop.pasting", defaultMessage: "Pasting…" })
          : snapshot.clipboardFailed
            ? intl.formatMessage({ id: "desktop.pasteFailed", defaultMessage: "Unable to paste." })
          : snapshot.controlFailed
            ? intl.formatMessage({ id: "desktop.controlFailed", defaultMessage: "Unable to take control." })
            : owned
              ? intl.formatMessage({ id: "desktop.ownership.local", defaultMessage: "You have control" })
              : snapshot.control === "requesting"
                ? intl.formatMessage({ id: "desktop.ownership.requesting", defaultMessage: "Taking control…" })
                : intl.formatMessage({ id: "desktop.ownership.watching", defaultMessage: "Watching desktop" });
    const feedbackTitle = snapshot.phase === "connecting"
      ? intl.formatMessage({ id: "desktop.connectingTitle", defaultMessage: "Connecting to desktop…" })
      : intl.formatMessage({ id: "desktop.unavailableTitle", defaultMessage: "Desktop unavailable" });
    const feedback = <div className="cloud-desktop-panel__feedback"
      data-live={snapshot.phase === "ready" ? "true" : "false"}
      data-preview={snapshot.preview ? "true" : "false"}
      aria-hidden={snapshot.phase === "ready" || undefined}
      role={snapshot.phase === "connecting" ? undefined : "status"}
      aria-live={snapshot.phase === "connecting" ? undefined : "polite"}>
      <div className="ui-empty-state__content">
        <span className="ui-empty-state__icon" aria-hidden="true">
          {snapshot.phase === "connecting" ? <ProgressIndicator /> : <MonitorOff />}
        </span>
        <div className="ui-empty-state__copy">
          <h2 className="ui-empty-state__title">{feedbackTitle}</h2>
          {snapshot.phase === "failed" || snapshot.phase === "unavailable" ? <p className="ui-empty-state__description">{status}</p> : null}
        </div>
        {snapshot.phase === "failed" ? <div className="ui-empty-state__actions">
          <button type="button" className="ui-button" data-density="compact" data-variant="outline"
            onClick={() => controller.current?.retry()}>
            <span className="ui-button__label">{intl.formatMessage({ id: "desktop.retry", defaultMessage: "Reconnect" })}</span>
          </button>
        </div> : null}
      </div>
    </div>;
    return <section ref={panel} tabIndex={-1} className="cloud-desktop-panel" data-phase={snapshot.phase} data-stage={snapshot.stage}
      data-control={snapshot.control} inert={!active || undefined}
      aria-label={intl.formatMessage({ id: "desktop.panel", defaultMessage: "Desktop" })}>
      <div className="ui-desktop-view" data-owned={owned ? "true" : "false"} style={geometry}>
      <div className="ui-desktop-view__viewport">
      <div className="ui-desktop-view__frame">
      <div className="ui-desktop-view__shadow" aria-hidden="true" />
      <div className="ui-desktop-view__ring" aria-hidden="true">
        <span className="ui-desktop-view__trace"><span /></span>
        <span className="ui-desktop-view__trace"><span /></span>
      </div>
      <div className="ui-desktop-view__controls" data-visible={snapshot.phase === "ready" ? "true" : "false"}
        aria-hidden={snapshot.phase !== "ready" || undefined} inert={snapshot.phase !== "ready" || undefined}>
      <div className="cloud-desktop-panel__toolbar ui-desktop-view__island" aria-busy={snapshot.control === "requesting"}>
        <span className="ui-desktop-view__floating-background" aria-hidden="true" />
        <span className="ui-desktop-view__visor-background" aria-hidden="true"><span /></span>
        <span className="ui-desktop-view__status" role="status" aria-live="polite">
          <span>{snapshot.phase === "failed" || snapshot.phase === "unavailable" ? null : status}</span>
          {/* Intrinsic localized geometry, not a fixed text width. Reserve ordinary
              ownership labels so waiting cannot move the cancel action. */}
          <span aria-hidden="true">{intl.formatMessage({ id: "desktop.ownership.watching", defaultMessage: "Watching desktop" })}</span>
          <span aria-hidden="true">{intl.formatMessage({ id: "desktop.ownership.requesting", defaultMessage: "Taking control…" })}</span>
          <span aria-hidden="true">{intl.formatMessage({ id: "desktop.ownership.local", defaultMessage: "You have control" })}</span>
        </span>
        {snapshot.control === "requesting" ? <span className="ui-desktop-view__waiting" aria-hidden="true"><span /><span /><span /></span> : null}
        <div className="cloud-desktop-panel__actions">
        {snapshot.textInputAvailable ? <button type="button"
          className="ui-button cloud-desktop-panel__keyboard" data-density="compact" data-variant="outline"
          disabled={snapshot.control !== "controlling"}
          aria-label={intl.formatMessage({ id: "desktop.keyboard", defaultMessage: "Show keyboard" })}
          title={intl.formatMessage({ id: "desktop.keyboard", defaultMessage: "Show keyboard" })}
          onClick={() => controller.current?.showKeyboard(intl.formatMessage({ id: "desktop.textInput", defaultMessage: "Type on desktop" }))}>
          <span className="ui-button__label"><Keyboard size={16} aria-hidden="true" /></span>
        </button> : null}
        {snapshot.pasteAvailable ? <button type="button" className="ui-button" data-density="compact" data-variant="outline"
          aria-label={intl.formatMessage({ id: "desktop.paste", defaultMessage: "Paste" })}
          title={intl.formatMessage({ id: "desktop.paste", defaultMessage: "Paste" })}
          disabled={!snapshot.canPaste || snapshot.clipboardBusy} aria-busy={snapshot.clipboardBusy || undefined}
          onClick={() => void controller.current?.pasteClipboard(() => navigator.clipboard.readText())}>
          {snapshot.clipboardBusy ? <LoadingRingIcon size={14} className="ui-button__spinner" /> : null}
          <span className="ui-button__label"><ClipboardPaste size={16} aria-hidden="true" /></span>
        </button> : null}
        <button type="button" className="ui-desktop-view__action"
          disabled={!active || snapshot.phase !== "ready" || (!snapshot.canControl && !adapter?.backend.requestTakeover)}
          aria-pressed={snapshot.control !== "observing"}
          {...(snapshot.canControl ? controlAction : { onClick: requestTakeover })}>
          <span className="ui-button__label cloud-desktop-panel__control-label">
            {Object.entries(controlLabels).map(([state, label]) => <span key={state}
              aria-hidden={state !== snapshot.control ? true : undefined}
              data-current={state === snapshot.control ? "true" : "false"}>{label}</span>)}
          </span>
        </button>
        </div>
      </div>
      </div>
      <div className="cloud-desktop-panel__body ui-desktop-view__surface">
        <div className="cloud-desktop-panel__surface" ref={element} role="region"
          {...(active && snapshot.phase === "ready" && snapshot.canControl && snapshot.control === "observing" ? surfaceAction : {})}
          tabIndex={snapshot.phase === "ready" ? 0 : -1}
          aria-label={intl.formatMessage({ id: "desktop.view", defaultMessage: "Desktop view" })} />
        {snapshot.preview ? <img className="ui-desktop-view__preview" src={snapshot.preview.dataUrl}
          alt="" aria-hidden="true" draggable={false} data-live={snapshot.phase === "ready" ? "true" : "false"} /> : null}
        {snapshot.phase === "connecting" || snapshot.phase === "ready" ? feedback : null}
      </div>
      </div>
      </div>
      {snapshot.trackpadAvailable ? <div className="ui-desktop-trackpad" hidden={!owned}>
        <div ref={trackpad} className="ui-desktop-trackpad__surface" role="group" data-sidebar-gesture="ignore"
          aria-label={intl.formatMessage({ id: "desktop.trackpad", defaultMessage: "Trackpad" })}>
          <span className="ui-desktop-trackpad__title" aria-hidden="true">{intl.formatMessage({ id: "desktop.trackpad", defaultMessage: "Trackpad" })}</span>
          <span className="ui-desktop-trackpad__hint">{intl.formatMessage({ id: "desktop.trackpadHint", defaultMessage: "Slide to move · Tap to click · Hold to drag" })}</span>
          <span className="ui-desktop-trackpad__detail">{intl.formatMessage({ id: "desktop.trackpadDetail", defaultMessage: "Two fingers to scroll · Two-finger tap for right-click" })}</span>
        </div>
      </div> : null}
      </div>
      {snapshot.phase === "failed" || snapshot.phase === "unavailable" ? feedback : null}
    </section>;
  };
}
