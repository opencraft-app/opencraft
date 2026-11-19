import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import { FilePreviewService, FilePreviewProvider } from "@opencraft/file-preview-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceSessions } from "../../apps/workbench-web/src/panels/workspace-sessions";
import { WorkspaceResourcePanel } from "../../apps/workbench-web/src/panels/workspace-resource-panel";
import { createIntlTestRoot } from "./intl-root";
import { setScopeBlobs, evidence } from "./workspace-scope-runtime";
import "../../apps/workbench-web/src/styles/app.scss";
const ctx = new Context();
await ctx.plugin(BlobResourceService);
await ctx.plugin(FilePreviewService);
setScopeBlobs(ctx.blobResources);
Object.assign(window, { scopeEvidence: evidence });
const client = new QueryClient();
const sessions = new WorkspaceSessions();
function Fixture() {
  const [id, setId] = useState("A");
  return (
    <QueryClientProvider client={client}>
      <nav>
        {["A", "B", "denied"].map((x) => (
          <button key={x} onClick={() => setId(x)}>
            Scope {x}
          </button>
        ))}
      </nav>
      <div style={{ height: "80vh" }}>
        <WorkspaceResourcePanel
          sessions={sessions}
          key={id}
          tab={{
            id: "resource:" + id,
            kind: "resource",
            title: "proof.txt",
            resource: "/workspace/proof.txt",
            region: "right",
            closable: true,
            preview: true,
            durableRoute: {
              kind: "workspace-resource",
              payloadVersion: 1,
              params: { resource: "/workspace/proof.txt", workspaceFileThreadId: id },
            },
          }}
        />
      </div>
    </QueryClientProvider>
  );
}
createIntlTestRoot(document.getElementById("host")!).render(
  <FilePreviewProvider service={ctx.filePreviews}>
    <Fixture />
  </FilePreviewProvider>,
);
