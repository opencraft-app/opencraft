import { WorkspaceSessions, workspaceLocationResource } from "./workspace-sessions";
import { workspaceResourceBasename, parseWorkspaceResource } from "./workspace-resource-model";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import { FilePreviewService } from "@opencraft/file-preview-web";
import { OfficePreviewPlugin } from "@opencraft/plugin-office-preview";
import { StructuredPreviewPlugin } from "@opencraft/plugin-structured-preview";
import type { Context } from "@deepseek-ai/cordis";
import { BranchIcon as GitBranch } from "@opencraft/design-system-web/action-icons";
import type { ReactNode } from "react";

import { createDeferredView } from "@opencraft/extension-react";

const WorkspaceResourcePanel = createDeferredView(async () => (await import("./workspace-resource-panel")).WorkspaceResourcePanel);

function EmptyPanel({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="right-panel-empty">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function ChangesPanel() {
  return (
    <EmptyPanel
      icon={<GitBranch size={18} />}
      title="No changes to review"
      description="Files changed by this task will appear here."
    />
  );
}

function resourceTitle(resource: string): string {
  const normalized = resource.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || resource;
}

export const BuiltinWorkbenchPanelPlugin = Object.assign(async function BuiltinWorkbenchPanelPlugin(ctx: Context) {
  const sessions = new WorkspaceSessions();
  ctx.effect(() => () => sessions.dispose());
  await ctx.plugin(FilePreviewService);
  await ctx.inject(["filePreviews", "workbenchPanels", "workbenchPanelRenderers"], async (ctx) => {
    await ctx.plugin(OfficePreviewPlugin);
    await ctx.plugin(StructuredPreviewPlugin);
    const ResourcePanel = (props: PanelRendererProps) => <WorkspaceResourcePanel {...props} sessions={sessions}
      onSessionChange={(location, dirty) => {
        const current = ctx.workbenchPanels.getOwnerSnapshot(props.ownerId)[props.tab.region].tabs.find(tab => tab.id === props.tab.id);
        if (!current) return;
        const resource = workspaceLocationResource(location);
        const title = workspaceResourceBasename(location.path) + (dirty ? " •" : "");
        if (current.title === title && current.closable === !dirty && current.durableRoute?.params.location === resource) return;
        ctx.workbenchPanels.dispatch(props.ownerId, { type: "update-tab", region: props.tab.region, tabId: props.tab.id,
          patch: { title, closable: !dirty, preview: dirty ? false : current.preview,
            durableRoute: { kind: "workspace-resource", payloadVersion: 1, params: { resource: props.tab.resource, location: resource } } } });
      }} />;
    const remove = [
      ctx.workbenchPanels.register({
        kind: "changes",
        createTab: () => ({
          id: "changes",
          kind: "changes",
          region: "right",
          title: "Changes",
          icon: "changes",
          showTabIcon: true,
          closable: true,
          preview: false,
          durableRoute: { kind: "changes", params: {}, payloadVersion: 1 },
        }),
      }),
      ctx.workbenchPanels.register<{ readonly resource: string; readonly preview?: boolean; readonly location?: string }>({
        kind: "resource",
        createTab: ({ resource, preview = true, location }) => ({
          id: `resource:${resource}`,
          kind: "resource",
          region: "right",
          title: workspaceResourceBasename(parseWorkspaceResource(location ?? resource).path),
          icon: "file",
          showTabIcon: true,
          resource,
          closable: true,
          preview,
          durableRoute: {
            kind: "workspace-resource",
            params: { resource, ...(location ? { location } : {}) },
            payloadVersion: 1,
          },
        }),
        disposeTab: (tab, ownerId) => { sessions.releaseTab(ownerId, tab.id); ctx.filePreviews.releaseTab(ownerId, tab.id); },
      }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "workspace.files.open",
        region: "right",
        order: 250,
        label: "Open files",
        creationLabel: "Files",
        icon: "folder",
        isAvailable: (context) => Boolean(context.cwd?.trim()),
        run: (context) => {
          if (!context.cwd?.trim()) return;
          ctx.workbenchPanels.open(context.ownerId, "resource", {
            resource: context.cwd,
            preview: false,
          });
        },
      }),
      ctx.workbenchPanelRenderers.register({ kind: "changes", Component: ChangesPanel }),
      ctx.workbenchPanelRenderers.register({ kind: "resource", Component: ResourcePanel, residency: "while-tab-open", previewPresentation: "retained-view", previewAnchor: "start" }),
    ];
    ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
  });
}, {
  inject: ["workbenchPanels", "workbenchPanelRenderers"],
});
