import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compile, Logger } from "sass";

const root = resolve(import.meta.dirname, "../../..");
const output = process.env.OPENCRAFT_HANDOFF_SMOKE_OUTPUT ?? "/tmp/opencraft-conversation-handoff";

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createConversationKey } from "@opencraft/chat-core";
import {
  buildOpenCraftThemeCssProperties,
  opencraftNeutralThemePalette,
  lavenderThemePalette,
} from "./packages/design-system/src/theme-engine";
import { embeddedLocaleCatalogs } from "./apps/workbench-web/src/i18n/catalogs";

const locale = new LocaleRuntime(embeddedLocaleCatalogs);
await locale.update({ localeOverride: "en-US" });
window.__setLocale = value => locale.update({ localeOverride: value });
window.__setTheme = (mode, lavender = false) => {
  document.documentElement.dataset.theme = mode;
  const palette = (lavender ? lavenderThemePalette : opencraftNeutralThemePalette)[mode];
  for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(mode, palette))) {
    document.documentElement.style.setProperty(key, value);
  }
};
window.__setTheme("light");

let seq = 0;
const controller = createComposerController(
  { type: "existing-thread", key: createConversationKey("local", "codex_thr_source") },
  { now: Date.now, createId: () => String(++seq) },
);

const models = [
  {
    id: "codex:gpt-6.1-sol[high]",
    value: "codex:gpt-6.1-sol[high]",
    label: "6.1 Sol",
    agentId: "codex",
    agentLabel: "Codex",
    isDefault: true,
    description: null,
    defaultEffort: "high",
    efforts: [],
    inputModalities: ["text", "image"],
  },
  {
    id: "codex:gpt-5.3[high]",
    value: "codex:gpt-5.3[high]",
    label: "5.3 Codex",
    agentId: "codex",
    agentLabel: "Codex",
    isDefault: false,
    description: null,
    defaultEffort: "high",
    efforts: [],
    inputModalities: ["text", "image"],
  },
  {
    id: "cursor:gemini-4-carbon",
    value: "cursor:gemini-4-carbon",
    label: "Gemini 4 Carbon",
    agentId: "cursor",
    agentLabel: "Cursor",
    isDefault: false,
    description: null,
    defaultEffort: "high",
    efforts: [
      { value: "medium", label: "Medium", description: null },
      { value: "high", label: "High", description: null },
    ],
    serviceTiers: [{ id: "fast", name: "Fast", description: "Fast tier" }],
    inputModalities: ["text", "image"],
  },
  {
    id: "pi-cli:claude-sonnet-4-5",
    value: "pi-cli:claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    agentId: "pi-cli",
    agentLabel: "Pi",
    isDefault: false,
    description: null,
    defaultEffort: "high",
    efforts: [{ value: "high", label: "High", description: null }],
    inputModalities: ["text", "image"],
  },
];

window.__handoffSubmissions = [];
window.__threadSubmissions = [];
window.__controller = controller;

function App() {
  const [handoff, setHandoff] = React.useState(null);
  window.__handoff = handoff;

  const catalog = React.useMemo(() => ({
    models,
    displayModels: models,
    permissionProfiles: [
      { id: "full", value: "full", label: "Full access", description: "All workspace actions", disabled: false, mode: "full" },
    ],
    agentGroups: [
      {
        id: "local",
        label: "Local",
        active: (handoff?.hostId ?? "local") === "local",
        machineId: "local",
        machineLabel: "本地Mac",
        machineRole: "local",
        isLocalMachine: true,
        isConversationMachine: true,
        crossDevice: false,
        models,
        select(model) {
          const sameAgent = model.agentId === "codex";
          if (!handoff && sameAgent) return;
          setHandoff(prev => ({
            hostId: "local",
            targetWorkspacePath: null,
            model: model.value,
            effort: model.defaultEffort,
            serviceTier: prev?.serviceTier && model.serviceTiers?.some(t => t.id === prev.serviceTier) ? prev.serviceTier : null,
            permissionProfile: prev?.permissionProfile ?? "full",
          }));
          return { selection: "handled" };
        },
      },
      {
        id: "devcloud",
        label: "Devcloud",
        active: handoff?.hostId === "devcloud",
        machineId: "devcloud",
        machineLabel: "Devcloud",
        machineRole: "server",
        isLocalMachine: false,
        isConversationMachine: false,
        crossDevice: true,
        models: models.filter(m => m.agentId === "codex"),
        select(model) {
          setHandoff(prev => ({
            hostId: "devcloud",
            targetWorkspacePath: prev?.hostId === "devcloud" ? prev.targetWorkspacePath : "/root/lighthouse_workspace",
            model: model.value,
            effort: model.defaultEffort,
            serviceTier: prev?.serviceTier && model.serviceTiers?.some(t => t.id === prev.serviceTier) ? prev.serviceTier : null,
            permissionProfile: prev?.permissionProfile ?? "full",
          }));
          return { selection: "handled" };
        },
      },
    ],
  }), [handoff]);

  const handoffState = handoff === null ? null : {
    sourceTitle: "Continue from Clone and run opencraft project",
    sourceAgentLabel: "Codex",
    workspacePath: "/workspace/opencraft",
    hostId: handoff.hostId ?? "local",
    model: handoff.model,
    effort: handoff.effort,
    serviceTier: handoff.serviceTier,
    permissionProfile: handoff.permissionProfile,
    isCrossDevice: (handoff.hostId ?? "local") === "devcloud",
    devices: [
      { id: "local", label: "本地Mac", role: "local", selected: (handoff.hostId ?? "local") === "local", connectable: true },
      { id: "devcloud", label: "Devcloud", role: "server", selected: (handoff.hostId ?? "local") === "devcloud", connectable: true },
    ],
    onSelectDevice(deviceId) {
      setHandoff(prev => prev ? {
        ...prev,
        hostId: deviceId,
        targetWorkspacePath: deviceId === "devcloud" ? "/root/lighthouse_workspace" : null,
      } : null);
    },
    targetWorkspacePath: handoff.targetWorkspacePath ?? "/root/lighthouse_workspace",
    targetWorkspaces: [
      { cwd: "/root/lighthouse_workspace", label: "lighthouse_workspace", selected: (handoff.targetWorkspacePath ?? "/root/lighthouse_workspace") === "/root/lighthouse_workspace" },
      { cwd: "/root/opencraft", label: "opencraft", selected: handoff.targetWorkspacePath === "/root/opencraft" },
    ],
    onSelectTargetWorkspace(cwd) {
      setHandoff(prev => prev ? { ...prev, targetWorkspacePath: cwd } : null);
    },
    canContinueInCurrentThread: (handoff.hostId ?? "local") === "local" && handoff.model.startsWith("codex:"),
    onChangeSelections(patch) {
      setHandoff(prev => prev ? { ...prev, ...patch } : null);
    },
    onSubmit() {
      const draft = controller.getSnapshot().draft;
      window.__handoffSubmissions.push({
        handoff,
        blocks: draft.document.blocks,
      });
      controller.dispatch({
        type: "replace-content",
        document: { version: 1, blocks: [{ type: "paragraph", children: [] }] },
        attachments: [],
        context: [],
      });
      setHandoff(null);
    },
    onContinueInCurrentThread() {
      controller.dispatch({
        type: "set-selections",
        patch: { model: handoff.model, effort: handoff.effort ?? undefined, serviceTier: handoff.serviceTier },
      });
      setHandoff(null);
    },
    onCancel() {
      setHandoff(null);
    },
  };

  return (
    <IntlRuntimeProvider runtime={locale}>
      <div style={{ maxWidth: 740, margin: "40px auto", padding: "0 16px" }}>
        <div style={{ marginBottom: 14, padding: "14px 18px", borderRadius: 16, border: "1px solid var(--color-border-subtle)", background: "var(--color-background-panel)", color: "var(--color-text-secondary)", font: "var(--typography-body-font)" }}>
          Previous Codex conversation response ready for follow-up or handoff.
        </div>
        <OpenCraftComposer
          controller={controller}
          selectionCatalog={catalog}
          mentionSuggestionsEnabled={false}
          addMenuContent={() => null}
          effectiveSelections={{ model: "codex:gpt-6.1-sol[high]", effort: "high", serviceTier: null, permissionProfile: "full" }}
          handoff={handoffState}
          onStartHandoff={() => {
            const currentModel = controller.getSnapshot().draft.selections.model ?? "codex:gpt-6.1-sol[high]";
            setHandoff({ model: currentModel, effort: "high", serviceTier: null, permissionProfile: "full" });
          }}
          isStreaming={false}
          onSubmit={intent => {
            window.__threadSubmissions.push(intent);
            return true;
          }}
          onCancel={() => {}}
        />
      </div>
    </IntlRuntimeProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;

const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, sourcefile: "conversation-handoff-fixture.tsx", loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty", ".scss": "empty" },
});
const sassOptions = {
  logger: Logger.silent,
  importers: [{
    findFileUrl(url: string) {
      const roots: Record<string, string> = {
        "@opencraft/design-system/": "packages/design-system/src/",
        "@opencraft/design-system-web/": "packages/design-system-web/src/",
        "@opencraft/plugin-cloud-desktop/": "plugins/cloud-desktop/src/",
      };
      for (const [prefix, target] of Object.entries(roots)) {
        if (url.startsWith(prefix)) return pathToFileURL(resolve(root, target, `${url.slice(prefix.length)}.scss`));
      }
      return null;
    },
  }],
};
const css = [
  compile(resolve(root, "apps/workbench-web/src/styles/app.scss"), sassOptions).css,
  compile(resolve(root, "packages/composer-editor/src/composer-handoff.scss"), sassOptions).css,
].join("\n");

const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles[0]!.contents);
  } else if (req.url === "/fixture.css") {
    res.setHeader("content-type", "text/css");
    res.end(css);
  } else {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0;background:var(--color-background-surface)"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  }
});
await new Promise<void>(resolveServer => server.listen(0, "127.0.0.1", resolveServer));

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  headless: true,
});

try {
  await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1200, height: 860 },
      isMobile: touch,
      hasTouch: touch,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript("window.__name = value => value");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    if (touch) {
      await page.evaluate(() => {
        document.documentElement.dataset.uiDensity = "touch";
      });
    }

    const editor = page.locator(".opencraft-composer-editor");
    await editor.waitFor();
    await editor.evaluate(el => { (window as any).__initialEditor = el; });
    if (touch) await editor.tap();

    const activate = async (locator: ReturnType<typeof page.locator>) => (touch ? locator.tap() : locator.click());
    const modelTrigger = page.locator(".opencraft-composer-mode--intelligence");

    // 1. Same-agent model change stays in current thread.
    await activate(modelTrigger);
    const menu = page.locator(".opencraft-composer-model-browser-surface");
    await menu.waitFor();
    await activate(menu.getByRole("menuitem", { name: "5.3 Codex", exact: true }));
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".opencraft-composer-handoff").count(), 0, "same-agent switch stays in current thread");
    assert.equal(await page.evaluate(() => (window as any).__controller.getSnapshot().draft.selections.model), "codex:gpt-5.3[high]");

    // 2. Cross-agent model selection enters Handoff to new thread inline!
    await activate(modelTrigger);
    await menu.waitFor();
    assert.equal(await menu.locator('.opencraft-composer-model-browser__machine-cards button[role="radio"]').count(), 2, "both machines appear as clickable machine cards");
    assert.equal(await menu.getByRole("tab", { name: "Codex · Devcloud", exact: true }).count(), 0, "other machine's agents stay tucked away until its machine tab is selected");
    await activate(menu.getByRole("tab", { name: "Cursor · 本地Mac", exact: true }));
    await activate(menu.getByRole("menuitem", { name: "Gemini 4 Carbon", exact: true }));
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });

    await page.locator(".opencraft-composer-handoff").waitFor();
    assert.equal(await page.locator(".opencraft-composer-handoff__title").innerText(), "Handoff to new thread");
    assert.equal(await page.locator(".opencraft-composer-handoff__prefix").innerText(), "Continue from");
    assert.equal(await page.locator(".opencraft-composer-handoff__pill-title").innerText(), "Continue from Clone and run opencraft project");
    assert.equal(await page.locator(".opencraft-composer-mode__model-label").innerText(), "Gemini 4 Carbon");
    assert.equal(
      await page.evaluate(() => (window as any).__controller.getSnapshot().draft.selections.model),
      "codex:gpt-5.3[high]",
      "source thread selections remain untouched during cross-agent handoff",
    );

    // Empty editor in handoff mode still enables "New thread" primary button!
    const newThreadButton = page.locator('[data-composer-primary-action="handoff"]');
    assert.equal(await newThreadButton.isEnabled(), true, "handoff can submit with empty extra instructions");

    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-en-empty-light.png` });

    // 3. Expand & collapse context details.
    await activate(page.locator(".opencraft-composer-handoff__pill"));
    await page.locator(".opencraft-composer-handoff__details").waitFor();
    await activate(page.locator(".opencraft-composer-handoff__pill"));
    await page.locator(".opencraft-composer-handoff__details").waitFor({ state: "hidden" });

    // 4. Switch to zh-CN and dark/lavender themes while preserving editor identity and draft!
    await editor.fill("换一下UI设计，一个对话如果换了模型，也改成这个样子");
    await page.evaluate(() => (window as any).__setLocale("zh-CN"));
    assert.equal(await page.locator(".opencraft-composer-handoff__title").innerText(), "移交到新对话");
    assert.equal(await page.locator(".opencraft-composer-handoff__prefix").innerText(), "继续自");
    assert.equal(await newThreadButton.innerText(), "新建对话");
    assert.equal(await editor.evaluate(el => el === (window as any).__initialEditor), true, "editor never remounts");
    assert.equal((await editor.innerText()).trim(), "换一下UI设计，一个对话如果换了模型，也改成这个样子");

    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-zh-filled-light.png` });
    await page.evaluate(() => (window as any).__setTheme("dark"));
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-zh-filled-dark.png` });
    await page.evaluate(() => (window as any).__setTheme("light", true));
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-zh-filled-lavender.png` });
    await page.evaluate(() => (window as any).__setTheme("light", false));

    // 4b. Switch directly to Devcloud's Codex from the model menu -> verify machine switcher, inline CTA & auto-close into cross-device handoff!
    assert.equal(await page.locator(".opencraft-composer-handoff__cross-device-notice").count(), 0);
    await activate(modelTrigger);
    await menu.waitFor();
    await activate(menu.locator('.opencraft-composer-model-browser__machine-cards button[data-value="devcloud"]'));
    assert.equal(await menu.getByRole("tab", { name: "Codex · Devcloud", exact: true }).getAttribute("aria-selected"), "true");
    const menuCrossNotice = menu.locator(".opencraft-composer-model-browser__cross-device-notice");
    await menuCrossNotice.waitFor();
    assert.match(await menuCrossNotice.innerText(), /JSONL/u);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-cross-device-menu-light.png` });
    await activate(menu.getByRole("button", { name: "切换到 Devcloud · Codex", exact: true }));
    await menu.waitFor({ state: "hidden" });
    assert.match(await page.locator(".opencraft-composer-mode__model-label").innerText(), /^Devcloud · /u);
    const crossNotice = page.locator(".opencraft-composer-handoff__cross-device-notice");
    await crossNotice.waitFor();
    assert.match(await crossNotice.innerText(), /执行机器与系统环境已改变.*JSONL/u);
    await activate(page.getByRole("button", { name: /目标文件夹：lighthouse_workspace/u }));
    const deviceMenu = page.locator('[role="menu"]');
    await deviceMenu.waitFor();
    await activate(deviceMenu.getByRole("menuitem", { name: "opencraft", exact: true }));
    assert.equal(await page.getByRole("button", { name: /目标文件夹：opencraft/u }).count(), 1);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-cross-device-light.png` });
    // Switch back to local Mac -> cross-device warning disappears cleanly!
    await activate(page.getByRole("button", { name: /目标设备：Devcloud/u }));
    await deviceMenu.waitFor();
    await activate(deviceMenu.getByRole("menuitem", { name: "本地Mac", exact: true }));
    await crossNotice.waitFor({ state: "hidden" });

    // 5. Cancel handoff restores original Codex model while keeping draft text!
    await activate(page.getByRole("button", { name: "取消移交", exact: true }));
    await page.locator(".opencraft-composer-handoff").waitFor({ state: "hidden" });
    assert.equal((await editor.innerText()).trim(), "换一下UI设计，一个对话如果换了模型，也改成这个样子");
    await page.waitForFunction(() => /5\.3 Codex/.test(document.querySelector(".opencraft-composer-mode--intelligence")?.textContent ?? ""));

    // 6. Explicit same-agent handoff from model menu + split options menu.
    await activate(modelTrigger);
    await menu.waitFor();
    await activate(menu.getByRole("menuitem", { name: "移交到新对话", exact: true }));
    await page.locator(".opencraft-composer-handoff").waitFor();
    await activate(page.getByRole("button", { name: "移交选项", exact: true }));
    const optionsMenu = page.locator(".opencraft-composer-handoff-menu");
    await optionsMenu.waitFor();
    await activate(optionsMenu.getByRole("menuitem", { name: "在当前对话继续", exact: true }));
    await page.locator(".opencraft-composer-handoff").waitFor({ state: "hidden" });

    // 7. Re-select Pi agent and submit handoff!
    await activate(modelTrigger);
    await menu.waitFor();
    await activate(menu.getByRole("tab", { name: "Pi · 本地Mac", exact: true }));
    await activate(menu.getByRole("menuitem", { name: "Claude Sonnet 4.5", exact: true }));
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await activate(newThreadButton);

    assert.equal(await page.evaluate(() => (window as any).__handoffSubmissions.length), 1);
    const submitted = await page.evaluate(() => (window as any).__handoffSubmissions[0]);
    assert.equal(submitted.handoff.model, "pi-cli:claude-sonnet-4-5");
    assert.equal(await page.locator(".opencraft-composer-handoff").count(), 0);
    assert.equal((await editor.innerText()).trim(), "");

    // Ensure no horizontal overflow on narrow viewport.
    const withinViewport = await page.locator(".opencraft-composer-shell").evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    });
    assert.equal(withinViewport, true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log("PASS conversation handoff: desktop + touch, en-US + zh-CN, light/dark/lavender, empty + filled submit, cancel + continue-here continuity. Screenshots: " + output);
} finally {
  await browser.close();
  await new Promise<void>(resolveServer => server.close(() => resolveServer()));
}
