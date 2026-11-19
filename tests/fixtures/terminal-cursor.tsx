import React from "react";
import { createWorkbenchPanelReactRuntime } from "../../packages/workbench-panels-react/src/index";
import { WorkbenchTerminalSessionRegistry, createTerminalWorkbenchPanelPlugin } from "../../plugins/terminal/src/index";
import { createIntlTestRoot } from "./intl-root";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const listeners = new Set<() => void>();
let state = {
  revision: 0,
  phase: "running",
  output: [] as { sequence: number; deltaBase64: string }[],
  exitCode: null,
  error: null,
};
const writes: string[] = [];
function emit(text: string) {
  state = {
    ...state,
    revision: state.revision + 1,
    output: [
      ...state.output,
      {
        sequence: state.revision + 1,
        deltaBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text))),
      },
    ],
  };
  listeners.forEach((fn) => fn());
}
const session = {
  processId: "cursor-fixture",
  getSnapshot: () => state,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  resize: async () => {},
  write: async (data: string) => {
    const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    writes.push(text);
    emit(text);
  },
  terminate: async () => {},
  dispose: async () => {},
};
const registry = new WorkbenchTerminalSessionRegistry(
  () =>
    ({
      resources: { terminal: { open: () => session } },
    }) as any,
);
const resource = registry.open({ hostId: "cursor-fixture", cwd: null });
const runtime = await createWorkbenchPanelReactRuntime();
await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
const Panel = runtime.renderers.resolve(runtime.renderers.getSnapshot(), "terminal")!;
(window as any).fixture = { emit, writes };
createIntlTestRoot(document.getElementById("root")!).render(
  <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
    <Panel
      ownerId="cursor-fixture"
      presentationId="cursor-fixture"
      active
      touchToolbar={new URLSearchParams(location.search).get("touch") !== "false"}
      tab={{ id: "cursor-fixture", kind: "terminal", region: "right", title: "Terminal", resource }}
    />
  </div>,
);
