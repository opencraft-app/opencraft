import React from "react";
import { createRoot } from "react-dom/client";
import { TodoBlock } from "../../apps/workbench-web/src/components/conversation-renderers/plan-and-compaction";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import "../../apps/workbench-web/src/styles/app.scss";

const overlay = document.getElementById("overlay")!;
createRoot(document.getElementById("root")!).render(
  <WorkbenchPresentationRootProvider target={overlay}>
    <TodoBlock block={{ id: "todo", type: "todo", entries: [
      { id: "one", text: "First plan step", status: "in-progress" },
      { id: "two", text: "Second plan step", status: "pending" },
    ] }} />
    <button type="button" id="outside" style={{ position: "fixed", right: 20, bottom: 20 }}>Outside</button>
  </WorkbenchPresentationRootProvider>,
);
