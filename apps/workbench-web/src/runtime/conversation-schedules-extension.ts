import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createDeferredView } from "@opencraft/extension-react";

export const conversationSchedulesExtension: TrustedExtensionDefinition = {
  manifest: { manifestVersion: 1, id: "opencraft.schedules", name: "Scheduled tasks", version: "0.1.0", apiVersion: 1,
    trust: "trusted", platforms: ["web", "electron"], activationEvents: ["onStartupFinished"] },
  activate(api) {
    const id = "opencraft.schedules";
    api.views.register({ id: `${id}.view`, title: "Scheduled tasks", viewType: id, platforms: ["web", "electron"] });
    api.settings.registerPage({ id, title: "Scheduled tasks", titleMessage: { id: "schedules.catalog.title", defaultMessage: "Scheduled tasks" },
      shortTitleMessage: { id: "schedules.catalog.title", defaultMessage: "Scheduled tasks" }, viewId: `${id}.view`, icon: "calendar", order: 304,
      layout: "document", platforms: ["web", "electron"], management: { familyId: id, scope: "host", entryPoint: "workbench" } });
    api.internal.register("platformViewRenderer", { viewType: id, Component: createDeferredView(async () => (await import("../components/scheduled-tasks-page")).ScheduledTasksPage) });
  },
};
