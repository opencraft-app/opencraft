import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    return entry.isDirectory()
      ? sourceFiles(child)
      : /\.tsx$/u.test(entry.name) ? [child] : [];
  });
}

import {
  createHermesCommandBuilder,
} from "../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-config/hermes-command-builder.ts";
import { parseHermesQrStream } from "../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-config/utils/hermes-parsers.ts";
import {
  getEligibleCronUpstreams,
  wouldCreateCronContextCycle,
} from "../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-automations-panel.tsx";
import type { CronJob } from "../plugins/lightvela-hermes/src/upstream/mono2/lib/hermes-cron-client.ts";
import {
  buildClawhubInstallCommand,
  buildSkillsshInstallCommand,
  skillIdentity,
} from "../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/skills-demo/skill-registries.ts";

function cron(id: string, contextFrom: string[] = [], overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    prompt: "",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    skills: [],
    enabled: true,
    state: "active",
    deliver: "local",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: contextFrom,
    context_from_hydrated: true,
    inference_config: null,
    ...overrides,
  };
}

test("Hermes QR command and parser preserve the mono2 acli protocol", () => {
  assert.equal(
    createHermesCommandBuilder().channel.getQrUrlCommand({ platform: "feishu", isI18n: false }),
    "acli gateway qr-url --platform feishu --wait true --greeting 'Hi，我是你刚刚使用LightVela创建的机器人，你现在可以跟我聊天了！' --agent 'main'",
  );
  assert.deepEqual(parseHermesQrStream([
    "starting",
    '{"platform":"weixin","status":"pending","url":"https://example/qr"}',
    '{"platform":"weixin","status":"success"}',
  ].join("\n")), { platform: "weixin", status: "success" });
  assert.deepEqual(parseHermesQrStream('{"platform":"weixin","error_code":"QR_CONFIG_FAILED"}'), {
    platform: "weixin",
    error_code: "QR_CONFIG_FAILED",
    status: "failed",
  });
});

test("cron upstream policy rejects paused, ended and cyclic dependencies", () => {
  const jobs = [
    cron("a", ["b"]),
    cron("b", ["c"]),
    cron("c"),
    cron("paused", [], { enabled: false, state: "paused" }),
    cron("ended", [], { state: "completed" }),
  ];
  assert.equal(wouldCreateCronContextCycle(jobs, "c", "a"), true);
  assert.deepEqual(getEligibleCronUpstreams(jobs, "c", Date.now()).map((job) => job.id), []);
  assert.deepEqual(getEligibleCronUpstreams(jobs, null, Date.now()).map((job) => job.id), ["a", "b", "c"]);
});

test("skill registry identity and install commands remain registry-specific", () => {
  assert.notEqual(
    skillIdentity({ registry: "clawhub", rawId: "frontend-design" }),
    skillIdentity({ registry: "skills-sh", rawId: "anthropics/skills/frontend-design" }),
  );
  assert.equal(buildClawhubInstallCommand("frontend-design"), "acli clawhub install 'frontend-design'");
  assert.equal(
    buildSkillsshInstallCommand("anthropics/skills/frontend-design"),
    "bash -lc 'cd \"$HOME\" && acli skills-sh install anthropics/skills/frontend-design'",
  );
});

test("embedded Hermes surfaces inherit the Workbench theme contract", () => {
  const css = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /--surface-base:\s*var\(--color-background-surface\)/);
  assert.match(css, /--color-black:\s*var\(--color-text-foreground\)/);
  assert.match(css, /--tea-color-bg-primary-default:\s*var\(--surface-raised\)/);
  assert.match(css, /--tea-color-brand:\s*var\(--color-accent-blue\)/);
  assert.match(css, /--lh-std-bg:\s*var\(--surface-raised\)/);
  assert.match(css, /--lh-std-text:\s*var\(--text-primary\)/);
  assert.match(css, /--lh-std-border-color:\s*var\(--color-border-light\)/);
  assert.match(css, /\.lh-std-channel-panel__connect-btn:not\(\.lh-std-channel-panel__connect-btn--reconnect\)/);
  assert.match(css, /--lh-channel-color/);
  assert.match(css, /:is\(\.lightvela-agent-console, \.lightvela-agent-console-portal\):where\(\[class~="bg-white"\]/);
  assert.match(css, /background-color:\s*color-mix\(in srgb, var\(--danger\) 8%, var\(--surface-raised\)\)/);
  assert.doesNotMatch(css, /--surface-base:\s*#fff(?:fff)?/i);
});

test("embedded Hermes portals consume the host-owned presentation planes", () => {
  const css = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url),
    "utf8",
  );
  const webTokens = readFileSync(
    new URL("../packages/design-system/src/tokens.web.scss", import.meta.url),
    "utf8",
  );
  const modalCss = readFileSync(
    new URL("../apps/workbench-web/src/components/modal/modal.scss", import.meta.url),
    "utf8",
  );
  const dialogSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/dialog.tsx", import.meta.url),
    "utf8",
  );
  const selectSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/select.tsx", import.meta.url),
    "utf8",
  );
  const popoverSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/popover.tsx", import.meta.url),
    "utf8",
  );

  assert.match(webTokens, /--layer-application-modal:\s*230/);
  assert.match(webTokens, /--layer-nested-modal:\s*240/);
  assert.match(webTokens, /--layer-confirmation-modal:\s*245/);
  assert.match(webTokens, /--layer-floating-control:\s*250/);
  assert.match(modalCss, /--modal-layer-base:\s*var\(--layer-application-modal,\s*230\)/);
  assert.match(modalCss, /z-index:\s*calc\(var\(--modal-layer-base\) \+ var\(--modal-stack-offset, 0\)\)/);
  assert.match(modalCss, /z-index:\s*calc\(var\(--modal-layer-base\) \+ var\(--modal-stack-offset, 0\) \+ 1\)/);
  assert.match(css, /\.lightvela-agent-console-portal\.lv-dialog-backdrop\s*\{[^}]*z-index:\s*var\(--layer-nested-modal,\s*240\)/s);
  assert.match(css, /\.lightvela-agent-console-portal\.lv-dialog-backdrop--confirmation\s*\{[^}]*z-index:\s*var\(--layer-confirmation-modal,\s*245\)/s);
  assert.match(css, /\.lightvela-agent-console-portal\.lv-floating-control\s*\{[^}]*z-index:\s*var\(--layer-floating-control,\s*250\)/s);
  // Upstream utility z-index remains intact; the scoped host role owns the
  // actual plane. The primitive, not the old control-shell string, is adapted.
  assert.match(dialogSource, /lightvela-agent-console-portal lv-dialog-backdrop/);
  assert.match(dialogSource, /lightvela-agent-console-portal lv-dialog-surface/);
  assert.match(css, /:is\([^)]*\.lightvela-agent-console-portal\.lv-dialog-surface[^)]*\)\s*\{[^}]*z-index:\s*calc\(var\(--layer-nested-modal,\s*240\) \+ 1\)/s);
  assert.match(selectSource, /lightvela-agent-console-portal lv-floating-control/);
  assert.match(popoverSource, /lightvela-agent-console-portal lv-floating-control/);

  const confirmationSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/alert-dialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(confirmationSource, /lv-dialog-backdrop--confirmation/);
  assert.match(confirmationSource, /lv-dialog-surface--confirmation/);
  assert.match(css, /\.lv-dialog-surface--confirmation\s*\{[^}]*z-index:\s*calc\(var\(--layer-confirmation-modal,\s*245\) \+ 1\)/s);
});

test("model Select and native purpose options consume the host token contract", () => {
  const css = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url),
    "utf8",
  );
  const selectSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/select.tsx", import.meta.url),
    "utf8",
  );
  const modelSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-model-config/agent-model-config-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(css, /--lv-option-background-selected:\s*var\(--color-background-button-secondary\)/);
  assert.match(css, /--lv-option-border-selected:\s*var\(--color-border-focus\)/);
  assert.match(css, /\.lightvela-agent-console-portal\.lv-select-content/);
  assert.match(css, /\.lv-select-item\[data-state="checked"\]/);
  assert.match(selectSource, /lv-select-trigger/);
  assert.match(selectSource, /lv-select-content/);
  assert.match(selectSource, /lv-select-item/);
  assert.match(modelSource, /<fieldset>[\s\S]*?<legend[^>]*>\{t\("选择用途"\)\}/);
  assert.match(modelSource, /type="radio"[\s\S]*?name="model-purpose"/);
  assert.match(modelSource, /checked=\{active\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(modelSource, /onChange=\{\(\) => setPurpose\(item.value\)\}/);
  for (const purpose of ["primary", "fallback", "idle"]) assert.ok(modelSource.includes(`value: "${purpose}"`));
});

test("custom provider append keeps shared model controls and host option styling", () => {
  const modelRoot = new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-model-config/", import.meta.url);
  const panel = readFileSync(new URL("agent-model-config-panel.tsx", modelRoot), "utf8");
  const formController = readFileSync(new URL("configured-provider-model-form.tsx", modelRoot), "utf8");
  const form = readFileSync(new URL("configured-provider-model-form-view.tsx", modelRoot), "utf8");
  const controls = readFileSync(new URL("model-form-controls.tsx", modelRoot), "utf8");

  assert.match(panel, /<ConfiguredProviderModelForm/);
  assert.match(panel, /canAppendToProviderGroup/);
  assert.match(panel, /addingProviderKey === group.key && anchor && canAppend/);
  assert.doesNotMatch(panel, /^<{7}|^={7}|^>{7}/m);
  assert.match(form, /from "\.\/model-form-controls"/);
  assert.match(form, /<Select/);
  assert.match(formController, /<ConfiguredProviderModelFormView/);
  assert.match(formController, /检测模型状态/);
  assert.match(form, /value=\{modelId\} onValueChange=\{onModelChange\}/);
  assert.match(form, /disabled=\{busy \|\| !selectionAvailable \|\| duplicate\}/);
  assert.match(controls, /MODEL_CONTROL_CLASS = "h-12 /);
  assert.match(controls, /MODEL_SELECT_CONTENT_CLASS = "max-h-80 w-\[var\(--radix-select-trigger-width\)\]/);
  assert.match(controls, /sm:grid-cols-\[minmax\(0,1fr\)_max-content\]/);
});

test("scheduled tasks delegates controls and surfaces to the host theme", () => {
  const source = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-automations-panel.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url),
    "utf8",
  );
  const segmentedSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/tabs.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /background:\s*"var\(--surface-raised\)"/);
  assert.match(source, /border:\s*"1px solid var\(--border-subtle\)"/);
  assert.doesNotMatch(source, /const PANEL_CARD_STYLE[\s\S]*?background:\s*"#ffffff"/);
  assert.match(source, /<Button\s+onClick=\{requestCreate\}/);
  assert.match(source, /<Tabs value=\{activeView\} onValueChange=/);
  assert.match(source, /<TabsList aria-label=\{t\("定时任务"\)\}/);
  for (const value of ["created", "ended", "recent"]) assert.match(source, new RegExp(`<TabsTrigger[^>]*value="${value}"`));
  assert.match(segmentedSource, /"lv-segmented-control"/);
  assert.match(segmentedSource, /"lv-segmented-control__item"/);
  assert.match(css, /\.lv-segmented-control__item\[data-state="active"\]/);
  const dialog = readFileSync(new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/automation-dialog-view.tsx", import.meta.url), "utf8");
  assert.match(dialog, /<Dialog open onOpenChange=/);
  assert.match(dialog, /<DialogContent portalClassName="agents-ui"/);
});

test("Hermes management actions share one host-tokenized button primitive", () => {
  const buttonSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/button.tsx", import.meta.url),
    "utf8",
  );
  const diagnosticsSource = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-diagnostics-views.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url),
    "utf8",
  );

  assert.match(buttonSource, /"lv-button",[\s\S]*?resolvedVariant === "default" \? "primary" : resolvedVariant/);
  assert.match(buttonSource, /default: \{ color: "var\(--color-text-button-primary\)" \}/);
  assert.match(buttonSource, /secondary: \{ color: "var\(--color-text-button-secondary\)" \}/);
  assert.doesNotMatch(buttonSource, /color: "white"/);
  assert.match(diagnosticsSource, /import \{ Button \} from "\.\.\/\.\.\/components\/ui\/button"/);
  assert.match(diagnosticsSource, /<Button[\s\S]*?variant="ghost"[\s\S]*?onClick=\{onExport\}/);
  assert.match(diagnosticsSource, /<Button[^>]*onClick=\{action\.onExecute\} disabled=\{action.disabled\}/);
  assert.doesNotMatch(diagnosticsSource, /function LogsSelectMenu/);
  assert.match(css, /--lv-card-background:\s*var\(--surface-raised\)/);
  assert.match(css, /\.lightvela-agent-console \.lv-card/);
  assert.match(css, /\.lightvela-agent-console \.lv-inset-surface/);
});

test("Web and Expo buttons implement one platform-neutral semantic contract", () => {
  const contractSource = readFileSync(
    new URL("../packages/design-system/src/button.shared.ts", import.meta.url),
    "utf8",
  );
  const nativeButtonSource = readFileSync(
    new URL("../apps/workbench-expo/src/components/ui/button.tsx", import.meta.url),
    "utf8",
  );
  const accountGateSource = readFileSync(
    new URL("../apps/workbench-expo/src/components/lightvela-account-gate.tsx", import.meta.url),
    "utf8",
  );
  const nativeHeaderSource = readFileSync(
    new URL("../apps/workbench-expo/src/components/workbench-header.tsx", import.meta.url),
    "utf8",
  );

  assert.match(contractSource, /export type ButtonVariant/);
  assert.match(contractSource, /"primary",[\s\S]*?"secondary",[\s\S]*?"outline",[\s\S]*?"ghost"/);
  assert.match(contractSource, /export const buttonSizeMetrics/);
  assert.match(nativeButtonSource, /from "@opencraft\/design-system\/button"/);
  assert.match(nativeButtonSource, /StyleSheet\.create\(\(theme\)/);
  assert.match(nativeButtonSource, /styles\.useVariants\(\{ variant, size, disabled: inactive \}\)/);
  assert.match(nativeButtonSource, /variants:\s*\{[\s\S]*?variant:\s*\{[\s\S]*?primary:/);
  assert.match(nativeButtonSource, /accessibilityState=\{\{ \.\.\.props\.accessibilityState, busy: loading, disabled: inactive \}\}/);
  assert.match(nativeButtonSource, /export function IconButton/);
  assert.match(accountGateSource, /import \{ Button \} from "\.\/ui\/button"/);
  assert.doesNotMatch(accountGateSource, /<Pressable/);
  assert.match(nativeHeaderSource, /<IconButton/);
  assert.doesNotMatch(nativeHeaderSource, /<Pressable/);
});

test("feature code delegates press mechanics to platform interaction primitives", () => {
  // Migrated action views consume Button/Radix; semantic native disclosures in
  // the generated closure remain valid and must not be rewritten for this test.
  const actionViews = ["agent-diagnostics-views.tsx", "automation-card-actions-view.tsx", "automation-form-actions-view.tsx", "agent-model-config/configured-provider-model-form-view.tsx"];
  const root = new URL("../plugins/lightvela-hermes/src/upstream/mono2/", import.meta.url);
  const webFeatureSources = actionViews.map((file) => readFileSync(new URL(`pages/marketing/${file}`, root), "utf8"));
  const nativeComponentSources = sourceFiles(
    new URL("../apps/workbench-expo/src/components/", import.meta.url),
  ).filter((file) => !file.pathname.includes("/components/ui/"));

  for (const source of webFeatureSources) {
    assert.match(source, /components\/ui\/button/);
    assert.match(source, /<Button\b/u);
    assert.doesNotMatch(source, /<button\b/u);
  }
  const button = readFileSync(new URL("components/ui/button.tsx", root), "utf8");
  assert.match(button, /const Comp = asChild \? Slot : "button"/);
  assert.match(button, /\.\.\.props/);
  const modelGroups = readFileSync(new URL("pages/marketing/agent-model-config/model-provider-views.tsx", root), "utf8");
  assert.match(modelGroups, /<button type="button"[\s\S]*?aria-expanded=\{expanded\} aria-controls=\{panelId\} disabled=\{toggleDisabled\} onClick=\{onToggle\}/);

  const nativePressables = nativeComponentSources.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/<Pressable\b[\s\S]*?\/>/gu)].map((match) => ({ file: file.pathname, tag: match[0] }));
  });
  assert.deepEqual(
    nativePressables.map(({ tag }) => tag),
    [
      '<Pressable accessibilityLabel="Close sidebar" onPress={() => setSidebarOpen(false)} style={styles.scrim} />',
    ],
  );
  const nativeComposer = readFileSync(new URL("../apps/workbench-expo/src/components/workbench-composer.tsx", import.meta.url), "utf8");
  assert.match(nativeComposer, /<ModalSurface\s+label="Model"[\s\S]*?onDismiss=\{\(\) => setModelPickerOpen\(false\)\}/);
});
