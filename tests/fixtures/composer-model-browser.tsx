import React, { useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer, type ComposerModelOption } from "@opencraft/composer-editor";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
let sequence = 0;
const controller = createComposerController({ type: "new-thread", draftId: "model-browser", execution: {
  hostId: "fixture", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
} }, { now: Date.now, createId: () => String(++sequence) });
controller.dispatch({ type: "set-selections", patch: { model: "codex:one[high]" } });
const model = (id: string, label: string): ComposerModelOption => ({ id, value: id, label, description: null, isDefault: false, efforts: [], defaultEffort: null });
const models: ComposerModelOption[] = [
  ...["one", "two", "three", ...Array.from({ length: 15 }, (_, i) => `extra-${i}`)].flatMap(name => ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => model(`codex:${name}[${effort}]`, `${name === "one" ? "Model One" : name === "two" ? "Model Two" : name} (${effort})`))),
  model("cursor:one", "Model One"), model("api:plain", "Plain model"),
  { ...model("cursor:thinking", "Cursor Thinking"), defaultEffort: "high", efforts: [{ value: "low", label: "Low", description: null }, { value: "high", label: "High", description: null }], serviceTiers: [{ id: "fast", name: "Fast", description: "" }] },
  { ...model("api:thinking", "Thinking model"), defaultEffort: "medium", efforts: [{ value: "medium", label: "Medium", description: null }, { value: "high", label: "High", description: null }], serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }] },
];
const sent: unknown[] = [], remembered: unknown[] = [];
function Fixture() {
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setFetching] = useState(false);
  Object.assign(window, { modelBrowserFixture: { controller, models, sent, remembered, setError, setFetching,
    setThemePreference, setAppearanceThemeId,
    selections: () => controller.getSnapshot().draft.selections,
  } });
  return <OpenCraftComposer controller={controller} selectionCatalog={{ models, permissionProfiles: [], modelError: error,
    isFetching, retryModels: () => { setError(null); setFetching(false); }, onConfigureModels: () => remembered.push("configure"),
    onRememberModelDefaults: value => remembered.push(value),
  }} onSubmit={intent => { sent.push(intent.selections); return false; }} />;
}
const locale = new URLSearchParams(location.search).get("locale") ?? "en-US";
createIntlTestRoot(document.getElementById("root")!, undefined, locale).render(<Fixture />);
