import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { WorkspaceResourcePreviewPanel } from "../../apps/workbench-web/src/panels/workspace-resource-panel";
import { createIntlTestRoot } from "./intl-root";
import { setMediaFixtureBlobs, mediaFixtureReads } from "./workspace-media-runtime";
import "../../apps/workbench-web/src/styles/app.scss";

const context = new Context();
await context.plugin(BlobResourceService);
setMediaFixtureBlobs(context.blobResources);
(window as unknown as { fixtureReads: typeof mediaFixtureReads }).fixtureReads = mediaFixtureReads;
const queryClient = new QueryClient();
function Fixture() {
  const [resource, setResource] = useState<string | null>(null);
  return <QueryClientProvider client={queryClient}>
    <div style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}>
      <button onClick={() => document.documentElement.setAttribute("data-theme", "dark")}>Dark</button>
      <button onClick={() => document.documentElement.setAttribute("data-theme", "light")}>Light</button>
      {resource === null ? null : <button onClick={() => setResource(null)}>Close</button>}
      {["report.pdf", "small.pdf", "broken.pdf", "voice.wav", "clip.webm", "unknown.bin", "report.html"].map(name => <WebChatDocument
        key={name} source={name === "report.html" ? "Report: `/fixture/report.html`" : `MEDIA:/fixture/${name}`} documentId={name} hostId="media-fixture"
        cwd="/fixture" theme="light" onOpenResource={target => setResource(target)}
      />)}
    </div>
    {resource === null ? null : <div style={{ height: "calc(100vh - 100px)" }}>
      <WorkspaceResourcePreviewPanel tab={{ id: resource, kind: "resource", title: resource, resource, region: "right", closable: true, preview: true }} />
    </div>}
  </QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("host")!).render(<Fixture />);
