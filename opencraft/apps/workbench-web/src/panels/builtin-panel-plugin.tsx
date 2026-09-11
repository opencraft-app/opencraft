import type { Context } from "@deepseek-ai/cordis";
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";

import { WorkspaceResourcePanel } from "./workspace-resource-panel";

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

export const BuiltinWorkbenchPanelPlugin = Object.assign(function BuiltinWorkbenchPanelPlugin(ctx: Context) {
  const remove = [
    ctx.workbenchPanels.register({
      kind: "changes",
      createTab: () => ({
        id: "changes",
        kind: "changes",
        region: "right",
        title: "Changes",
        icon: "changes",
        closable: true,
        preview: false,
        durableRoute: { kind: "changes", params: {}, payloadVersion: 1 },
      }),
    }),
    ctx.workbenchPanels.register<{ readonly resource: string }>({
      kind: "resource",
      createTab: ({ resource }) => ({
        id: `resource:${resource}`,
        kind: "resource",
        region: "right",
        title: resourceTitle(resource),
        icon: "file",
        resource,
        closable: true,
        preview: true,
        durableRoute: {
          kind: "workspace-resource",
          params: { resource },
          payloadVersion: 1,
        },
      }),
    }),
    ctx.workbenchPanelRenderers.register({ kind: "changes", Component: ChangesPanel }),
    ctx.workbenchPanelRenderers.register({ kind: "resource", Component: WorkspaceResourcePanel }),
  ];
  ctx.effect(() => () => remove.reverse().forEach((dispose) => dispose()));
}, {
  inject: ["workbenchPanels", "workbenchPanelRenderers"],
});
