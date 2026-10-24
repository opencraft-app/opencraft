import type { Context } from "@deepseek-ai/cordis";
import { createDeferredView } from "@opencraft/extension-react";
import type { DesktopBackend } from "./contract";
import type { DesktopSurfaceFactory } from "./viewer";
import type { DesktopViewController } from "./controller";

export * from "./contract";
export * from "./viewer";
export { DesktopViewController } from "./controller";

/** Install a real pair together; a capability flag without a working adapter
 * cannot advertise a desktop. No production mock or localhost fallback. */
export interface CloudDesktopPluginAdapter {
  readonly backend: DesktopBackend;
  readonly surfaces: DesktopSurfaceFactory;
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
        id: "cloud-desktop", kind: "cloud-desktop", region: "right", title: "Cloud computer",
        icon: "desktop", showTabIcon: true, resource: conversationId, closable: true, preview: false,
      }),
      // Close/owner release revoke input immediately, not after a Shell exit animation.
      disposeTab: (_tab, ownerId) => {
        for (const [controller, owner] of controllers) if (owner === ownerId) controller.dispose();
      },
    }));
    ctx.effect(() => ctx.workbenchPanelRenderers.register({
      kind: "cloud-desktop", Component: createDeferredView(async () => (await import("./panel")).createDesktopPanel(adapter, controllers)), residency: "while-tab-open",
    }));
    if (adapter) ctx.effect(() => {
      const observed = new Map<string, boolean>();
      const isAvailable = (scope: string) => {
        const value = available(scope);
        observed.set(scope, value);
        return value;
      };
      const register = () => ctx.workbenchPanels.registerToolbarAction({
        id: "opencraft.cloud-desktop.open", region: "right", order: 250,
        label: "Cloud computer", creationLabel: "Cloud computer", icon: "desktop",
        isAvailable: context => isAvailable(context.resourceOwnerId),
        run: context => {
          if (!isAvailable(context.resourceOwnerId)) return;
          ctx.workbenchPanels.open(context.ownerId, "cloud-desktop", { conversationId: context.resourceOwnerId });
        },
      });
      let remove = register();
      // Runtime/binding observations can be emitted by a toolbar consumer's
      // layout effect. Republishing unchanged availability feeds that update
      // straight back into React (maximum update depth / production error 185).
      const unsubscribe = adapter.backend.subscribe(() => {
        let changed = false;
        for (const [scope, previous] of observed) {
          const current = available(scope);
          observed.set(scope, current);
          if (current !== previous) changed = true;
        }
        if (changed) { remove(); remove = register(); }
      });
      return () => { unsubscribe(); observed.clear(); remove(); };
    });
    ctx.effect(() => () => {
      for (const controller of controllers.keys()) controller.dispose();
      controllers.clear();
    });
  }, { inject: ["workbenchPanels", "workbenchPanelRenderers"] });
}
