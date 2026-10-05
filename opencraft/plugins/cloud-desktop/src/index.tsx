import type { Context } from "@deepseek-ai/cordis";
import { useIntl } from "@opencraft/i18n/react";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import React, { useEffect, useRef, useState } from "react";
import { ClipboardPaste, MonitorOff } from "lucide-react";
import type { DesktopBackend } from "./contract";
import { DesktopViewController, type DesktopViewSnapshot } from "./controller";
import type { DesktopSurfaceFactory } from "./viewer";

export * from "./contract";
export * from "./viewer";
export { DesktopViewController } from "./controller";

/** Install a real pair together; a capability flag without a working adapter
 * cannot advertise a desktop. No production mock or localhost fallback. */
export interface CloudDesktopPluginAdapter {
  readonly backend: DesktopBackend;
  readonly surfaces: DesktopSurfaceFactory;
}

function createDesktopPanel(adapter: CloudDesktopPluginAdapter | undefined,
  controllers: Map<DesktopViewController, string>) {
  return function DesktopPanel({ tab, ownerId }: PanelRendererProps) {
    const intl = useIntl();
    const element = useRef<HTMLDivElement>(null);
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
    useEffect(() => {
      if (!adapter || !tab.resource || !element.current) return;
      const current = new DesktopViewController(adapter.backend, adapter.surfaces, tab.resource, element.current);
      controller.current = current;
      controllers.set(current, ownerId);
      const unsubscribe = current.subscribe(() => setSnapshot(current.getSnapshot()));
      const release = () => current.releaseControl();
      const visibility = () => { if (document.visibilityState !== "visible") release(); };
      window.addEventListener("blur", release);
      document.addEventListener("visibilitychange", visibility);
      current.start();
      setSnapshot(current.getSnapshot());
      return () => {
        unsubscribe();
        window.removeEventListener("blur", release);
        document.removeEventListener("visibilitychange", visibility);
        controller.current = null;
        controllers.delete(current);
        current.dispose();
      };
    }, [tab.resource, ownerId]);

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
            : snapshot.control === "controlling"
              ? intl.formatMessage({ id: "desktop.controlling", defaultMessage: "You are in control." })
              : snapshot.control === "requesting"
                ? intl.formatMessage({ id: "desktop.requesting", defaultMessage: "Requesting control…" })
                : intl.formatMessage({ id: "desktop.viewing", defaultMessage: "Viewing desktop." });
    const feedbackTitle = snapshot.phase === "connecting"
      ? intl.formatMessage({ id: "desktop.connectingTitle", defaultMessage: "Connecting to desktop…" })
      : intl.formatMessage({ id: "desktop.unavailableTitle", defaultMessage: "Desktop unavailable" });
    const feedback = <div className="cloud-desktop-panel__feedback"
      role={snapshot.phase === "connecting" ? undefined : "status"}
      aria-live={snapshot.phase === "connecting" ? undefined : "polite"}>
      <div className="ui-empty-state__content">
        <span className="ui-empty-state__icon" aria-hidden="true">
          {snapshot.phase === "connecting" ? <span className="ui-progress-ring" /> : <MonitorOff />}
        </span>
        <div className="ui-empty-state__copy">
          <h2 className="ui-empty-state__title">{feedbackTitle}</h2>
          {snapshot.phase !== "connecting" ? <p className="ui-empty-state__description">{status}</p> : null}
        </div>
        {snapshot.phase === "failed" ? <div className="ui-empty-state__actions">
          <button type="button" className="ui-button" data-density="compact" data-variant="outline"
            onClick={() => controller.current?.retry()}>
            <span className="ui-button__label">{intl.formatMessage({ id: "desktop.retry", defaultMessage: "Reconnect" })}</span>
          </button>
        </div> : null}
      </div>
    </div>;
    return <section className="cloud-desktop-panel" data-phase={snapshot.phase} data-stage={snapshot.stage}
      data-control={snapshot.control} aria-label={intl.formatMessage({ id: "desktop.panel", defaultMessage: "Desktop" })}
      onBlurCapture={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        controller.current?.releaseControl();
      }
    }}>
      <div className="cloud-desktop-panel__toolbar" aria-busy={snapshot.control === "requesting"}
        hidden={snapshot.phase === "failed" || snapshot.phase === "unavailable"}>
        <span role="status" aria-live="polite">{snapshot.phase === "failed" || snapshot.phase === "unavailable" ? null : status}</span>
        <div className="cloud-desktop-panel__actions">
        <button type="button" className="ui-button" data-density="compact" data-variant="outline"
          aria-label={intl.formatMessage({ id: "desktop.paste", defaultMessage: "Paste" })}
          title={intl.formatMessage({ id: "desktop.paste", defaultMessage: "Paste" })}
          disabled={!snapshot.canPaste || snapshot.clipboardBusy} aria-busy={snapshot.clipboardBusy || undefined}
          onClick={() => void controller.current?.pasteClipboard(() => navigator.clipboard.readText())}>
          {snapshot.clipboardBusy ? <span aria-hidden="true" className="ui-button__spinner" /> : null}
          <span className="ui-button__label"><ClipboardPaste size={16} aria-hidden="true" /></span>
        </button>
        <button type="button" className="ui-button" data-density="compact"
          data-variant="outline" disabled={snapshot.phase !== "ready" || !snapshot.canControl}
          aria-pressed={snapshot.control === "controlling"}
          onClick={() => snapshot.control === "observing"
            ? void controller.current?.requestControl() : controller.current?.releaseControl()}>
          <span className="ui-button__label">{snapshot.control === "requesting"
            ? intl.formatMessage({ id: "desktop.cancel", defaultMessage: "Cancel" })
            : snapshot.control === "controlling"
            ? intl.formatMessage({ id: "desktop.release", defaultMessage: "Stop controlling" })
            : intl.formatMessage({ id: "desktop.control", defaultMessage: "Take control" })}</span>
        </button>
        </div>
      </div>
      <div className="cloud-desktop-panel__body">
        <div className="cloud-desktop-panel__surface" ref={element} role="region"
          tabIndex={snapshot.phase === "ready" ? 0 : -1}
          aria-label={intl.formatMessage({ id: "desktop.view", defaultMessage: "Desktop view" })} />
        {snapshot.phase === "connecting" ? feedback : null}
      </div>
      {snapshot.phase === "failed" || snapshot.phase === "unavailable" ? feedback : null}
    </section>;
  };
}

/** Trusted built-in plugin using the existing Panel ABI, not a new public
 * extension permission or a global machine picker. */
export function createCloudDesktopWorkbenchPanelPlugin(adapter?: CloudDesktopPluginAdapter) {
  return Object.assign(function CloudDesktopWorkbenchPanelPlugin(ctx: Context) {
    const controllers = new Map<DesktopViewController, string>();
    const available = (conversationId: string) => {
      try { return adapter?.backend.resolveTarget(conversationId)?.conversationId === conversationId; }
      catch { return false; }
    };
    ctx.effect(() => ctx.workbenchPanels.register<{ readonly conversationId: string }>({
      kind: "cloud-desktop",
      createTab: ({ conversationId }) => ({
        id: "cloud-desktop", kind: "cloud-desktop", region: "right", title: "Desktop",
        icon: "desktop", showTabIcon: true, resource: conversationId, closable: true, preview: false,
      }),
      // Close/owner release revoke input immediately, not after a Shell exit animation.
      disposeTab: (_tab, ownerId) => {
        for (const [controller, owner] of controllers) if (owner === ownerId) controller.dispose();
      },
    }));
    ctx.effect(() => ctx.workbenchPanelRenderers.register({
      kind: "cloud-desktop", Component: createDesktopPanel(adapter, controllers),
    }));
    if (adapter) ctx.effect(() => {
      const register = () => ctx.workbenchPanels.registerToolbarAction({
        id: "opencraft.cloud-desktop.open", region: "right", order: 250,
        label: "Desktop", creationLabel: "Desktop", icon: "desktop",
        isAvailable: context => available(context.resourceOwnerId),
        run: context => {
          if (!available(context.resourceOwnerId)) return;
          ctx.workbenchPanels.open(context.ownerId, "cloud-desktop", { conversationId: context.resourceOwnerId });
        },
      });
      let remove = register();
      // Panel toolbar snapshots must notify even when the route has not changed.
      const unsubscribe = adapter.backend.subscribe(() => { remove(); remove = register(); });
      return () => { unsubscribe(); remove(); };
    });
    ctx.effect(() => () => {
      for (const controller of controllers.keys()) controller.dispose();
      controllers.clear();
    });
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}
