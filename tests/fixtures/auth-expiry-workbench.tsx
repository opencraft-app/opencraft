import React from "react";
import { createIntlTestRoot } from "./intl-root";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createWebWorkbenchApplication } from "../../apps/workbench-web/src/runtime/web-workbench-application";
import { WorkbenchRoot } from "../../apps/workbench-web/src/workbench-root";
import { asHostId } from "@opencraft/chat-core";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
setThemePreference(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");
const application = await createWebWorkbenchApplication({ hostProfileMode: "configured", navigationMode: "memory" });
const supervisor = application.supervisor;
if (supervisor.mode !== "active") throw Error("Auth recovery fixture requires the real active Workbench");
await supervisor.registry.ensureConnected("local-codex");
supervisor.commands.navigateToHome({
  execution: { hostId: asHostId("local-codex"), workspace: { cwd: null, runtimeWorkspaceRoots: [] } },
  mode: "replace",
});
(window as any).authRecovery = {
  snapshot: () => supervisor.registry.getRuntime("local-codex").getSnapshot(),
  dispose: () => application.dispose(),
};
createIntlTestRoot(document.getElementById("root")!).render(<WorkbenchRoot application={application} />);
