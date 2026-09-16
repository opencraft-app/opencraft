import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

const script = readFileSync(new URL("../scripts/sync-mono2-agent-console.mjs", import.meta.url), "utf8");
const adapterSource = script.slice(script.indexOf("function applyWorkbenchAdapter("), script.indexOf("\nconst files = collectSourceClosure();"));
// Execute the real generator's pure adaptation step, without deleting/writing its output tree.
const adapt = new Function(`${adapterSource}\nreturn applyWorkbenchAdapter;`)() as (source: string, file: string) => string;
// The production adapter runs after @/ imports are localized. Preserve that
// input convention here without executing the generator's output writes.
const upstream = (file: string) => readFileSync(new URL(`../../frontend/src/${file}`, import.meta.url), "utf8").replace(/(["'])@\/([^"']+)\1/g, (_match, quote: string, imported: string) => {
  const relative = posix.relative(posix.dirname(file), imported);
  return `${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`;
});

test("all consumed Radix portal primitives receive the host scope and their own presentation role", () => {
  const cases = [
    ["dialog", ["lightvela-agent-console-portal lv-dialog-backdrop", "lightvela-agent-console-portal lv-dialog-surface", "lv-icon-button"]],
    ["alert-dialog", ["lightvela-agent-console-portal lv-dialog-backdrop lv-dialog-backdrop--confirmation", "lightvela-agent-console-portal lv-dialog-surface lv-dialog-surface--confirmation"]],
    ["select", ["lv-select-trigger", "lightvela-agent-console-portal lv-floating-control lv-select-content", "lv-select-viewport", "lv-select-item"]],
    ["popover", ["lightvela-agent-console-portal lv-floating-control lv-popover-content"]],
    ["dropdown-menu", ["lightvela-agent-console-portal lv-floating-control lv-dropdown-content", "lv-dropdown-item"]],
    ["tooltip", ["lightvela-agent-console-portal lv-floating-control lv-tooltip-content", "lv-tooltip-arrow"]],
  ] as const;
  for (const [name, roles] of cases) {
    const file = `components/ui/${name}.tsx`;
    const result = adapt(upstream(file), file);
    for (const role of roles) assert.ok(result.includes(role), `${name} missing ${role}`);
  }
});

test("controlled form primitives preserve Radix state and expose host styling roles", () => {
  for (const [name, roles] of [
    ["checkbox", ["lv-checkbox", "CheckboxPrimitive.Root", "CheckboxPrimitive.Indicator"]],
    ["switch", ["lv-switch", "lv-switch__thumb", "SwitchPrimitive.Root", "SwitchPrimitive.Thumb"]],
    ["tabs", ["lv-segmented-control", "lv-segmented-control__item", "TabsPrimitive.Trigger"]],
  ] as const) {
    const file = `components/ui/${name}.tsx`;
    const result = adapt(upstream(file), file);
    for (const role of roles) assert.ok(result.includes(role), `${name} missing ${role}`);
  }
  const button = adapt(upstream("components/ui/button.tsx"), "components/ui/button.tsx");
  assert.match(button, /resolvedVariant === "default" \? "primary" : resolvedVariant/);
  assert.match(button, /"lv-button"/);
  assert.match(button, /default: \{ color: "var\(--color-text-button-primary\)" \}/);
  assert.doesNotMatch(button, /color: "white"/);
});

test("primitive adaptations reject both missing and duplicated source anchors", () => {
  const file = "components/ui/dialog.tsx";
  const source = upstream(file);
  const anchor = "className={cn(overlayBackdropClass, className)}";
  assert.ok(source.includes(anchor));
  assert.throws(() => adapt(source.replace(anchor, 'className="changed-upstream"'), file), /adapter anchor/);
  assert.throws(() => adapt(source.replace(anchor, `${anchor}\n${anchor}`), file), /adapter anchor/);
});

test("feature adaptation preserves SkillsDataLayer ownership without seeding the whole frontend host", () => {
  const panel = adapt(upstream("pages/marketing/agent-skills-panel.tsx"), "pages/marketing/agent-skills-panel.tsx");
  assert.match(panel, /skillsDataLayer: SkillsDataLayer/);
  assert.match(panel, /dataLayer=\{skillsDataLayer\}/);
  const demo = adapt(upstream("pages/marketing/skills-demo/SkillsDemoPanel.tsx"), "pages/marketing/skills-demo/SkillsDemoPanel.tsx");
  assert.match(demo, /dataLayer: SkillsDataLayer/);
  assert.doesNotMatch(demo, /const dataLayer = useMemo/);
  const seeds = script.slice(script.indexOf("const seeds = ["), script.indexOf("\nconst publicAssets"));
  assert.doesNotMatch(seeds, /agent-settings-page|agents-console|agent-chat-panel|agent-terminal-panel|agents-workbench/);
});

test("injected ownership and environment seams reject missing or repeated anchors", () => {
  for (const file of ["pages/marketing/agent-skills-panel.tsx", "pages/marketing/skills-demo/SkillsDemoPanel.tsx", "repositories/http-repositories.ts", "lib/region.ts", "lib/auth-api-base.ts", "contexts/repository-context.tsx"]) {
    const source = upstream(file);
    assert.doesNotThrow(() => adapt(source, file), `${file} must still match current upstream`);
    assert.throws(() => adapt("", file), /adapter anchor/, `${file} must not silently skip ownership adaptation`);
    assert.throws(() => adapt(`${source}\n${source}`, file), /adapter anchor/, `${file} must not silently adapt only the first owner`);
  }
});

test("confirmation, floating and selected controls use host tokens and actual Radix data states", () => {
  const css = readFileSync(new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url), "utf8");
  assert.match(css, /\.lv-dialog-surface--confirmation\s*\{[^}]*z-index:\s*calc\(var\(--layer-confirmation-modal,\s*245\) \+ 1\)/s);
  assert.match(css, /\.lv-tooltip-arrow\s*\{[^}]*fill:\s*var\(--surface-raised\)/s);
  assert.match(css, /\.lv-checkbox\[data-state="indeterminate"\]/);
  assert.match(css, /\.lv-checkbox\[data-state="checked"\]/);
  assert.match(css, /\.lv-segmented-control__item\[data-state="active"\]/);
  assert.match(css, /\.lv-switch\[data-state="checked"\]/);
});
