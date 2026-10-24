import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");

// Actual Sidebar owns grouping and action state; only action RPCs are synthetic.
const probe = `
import React, { useState } from 'react';
import { createIntlTestRoot } from '/tests/fixtures/intl-root.tsx';
import { Sidebar } from '/apps/workbench-web/src/components/sidebar.tsx';
import { SidebarLayoutStore } from '@opencraft/sidebar-layout';
import { threadServerOrigin } from '@opencraft/workbench-runtime';
import { initializeAppearanceTheme, setThemePreference } from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout = await SidebarLayoutStore.open({ load: async () => null, save: async (_, doc) => doc });
const actions = [];
let releaseFork;
function Probe() {
  const [threads, setThreads] = useState(['fixture', 'peer'].map((id, i) => ({
    id, title: id === 'fixture' ? 'Fixture thread' : 'Peer thread', project: 'complete-project-name',
    status: 'ready', updatedAt: Date.now() / 1000 - i, connectionHostId: 'local',
    connectionHostLabel: 'Local', serverOrigin: threadServerOrigin({ serverId: 'local-server', label: 'Local' }),
  })));
  const [active, setActive] = useState('fixture');
  const [deletable, setDeletable] = useState(false);
  window.fixture = {
    actions, setThemePreference,
    enableDelete: () => setDeletable(true),
    setTargetHost: hostId => setThreads(current => current.map(thread => thread.id === 'fixture'
      ? { ...thread, connectionHostId: hostId, connectionHostLabel: hostId === 'local' ? 'Local' : 'Remote',
          serverOrigin: threadServerOrigin({ serverId: hostId + '-server', label: hostId }) } : thread)),
    regroup: status => setThreads(current => current.map(thread => thread.id === 'fixture' ? { ...thread, status } : thread)),
    releaseFork: () => releaseFork(),
  };
  return <div style={{ width: 'min(320px,100vw)', height: '100vh' }}>
    <Sidebar threads={threads} activeHostId='local' activeThreadId={active} sidebarLayout={layout}
      onSelectThread={(hostId, id) => { actions.push(['select', hostId, id]); setActive(id); }}
      onNewTask={() => {}} onOpenSettings={() => {}} showFooter={false}
      threadCapabilities={() => ({ rename: true, fork: true, archive: true, delete: deletable })}
      threadActions={{
        onRename: async (target, title) => {
          setThreads(current => current.map(thread => thread.id === target.threadId ? { ...thread, title } : thread));
          actions.push(['rename', target.hostId, target.threadId, title]);
        },
        onFork: async target => {
          actions.push(['fork-start', target.hostId, target.threadId]);
          await new Promise(resolve => { releaseFork = resolve; });
          actions.push(['fork-complete', target.hostId, target.threadId]);
        },
        onArchive: async target => { actions.push(['archive', target.hostId, target.threadId]); },
        onDelete: async target => { actions.push(['delete', target.hostId, target.threadId]); },
      }} />
  </div>;
}
createIntlTestRoot(document.getElementById('root'), undefined, 'en-US').render(<Probe />);
`;
const probeId = "/thread-probe.tsx";
const server = await createServer({ root: process.cwd(), configFile: false, cacheDir: "node_modules/.vite-thread-management", logLevel: "error",
  esbuild: { jsx: "automatic", target: "esnext" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "thread-management-probe", enforce: "pre",
    resolveId: id => id === probeId ? probeId : null, load: id => id === probeId ? probe : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/thread-probe.tsx"></script>');
    }); },
  }] });
let browser: any;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 900, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded", timeout: 60000 });
    const row = (title: string) => page.getByRole("button").filter({ has: page.getByText(title, { exact: true }) });
    const fixture = row("Fixture thread"), peer = row("Peer thread");
    await fixture.waitFor({ timeout: 60000 });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    assert.equal(await fixture.getAttribute("aria-current"), "page");
    assert.equal(await peer.getAttribute("aria-current"), null);
    assert.equal(await page.getByText("complete-project-name", { exact: true }).count(), 2);
    assert.equal(await page.locator("button button").count(), 0);

    const trigger = (title: string) => page.getByRole("button", { name: `Actions for ${title}`, exact: true });
    const openActions = async (title: string, canDelete = false) => {
      const button = trigger(title);
      if (touch) {
        const box = await button.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44);
        await button.tap();
      } else { await button.locator("..").hover(); await button.click(); }
      await page.getByRole("menu").waitFor();
      assert.equal(await page.getByRole("menu").count(), 1);
      assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Rename", "Create branch", "Archive", ...(canDelete ? ["Delete"] : [])]);
    };
    const invoke = async (locator: any) => { if (touch) await locator.tap(); else await locator.click(); };

    const surface = peer.locator(".."), selectedSurface = fixture.locator("..");
    const background = (element: any) => element.evaluate((node: Element) => getComputedStyle(node).backgroundColor);
    const beforeHover = await background(surface), selectedBackground = await background(selectedSurface);
    if (!touch) {
      const status = surface.locator('.sidebar-activity-item__trailing');
      const before = await status.boundingBox();
      await peer.hover();
      await page.waitForFunction(([node, color]: any) => getComputedStyle(node).backgroundColor !== color,
        [await surface.elementHandle(), beforeHover]);
      assert.deepEqual(await status.boundingBox(), before, "revealing actions cannot move the status slot");
      await fixture.hover();
      assert.equal(await background(selectedSurface), selectedBackground, "selected surface remains stable on hover");
    }

    // Independent menu hit targets must not navigate, including touch input.
    await openActions("Peer thread");
    await page.keyboard.press("Escape");
    if (touch) assert.equal(await background(surface), beforeHover, "touch does not leave a mouse hover surface");
    assert.equal(await fixture.getAttribute("aria-current"), "page");
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), []);
    await openActions("Fixture thread");
    await invoke(page.getByRole("menuitem", { name: "Rename", exact: true }));
    const input = page.getByRole("textbox", { name: "Conversation name", exact: true });
    await input.fill("Renamed fixture");
    assert.equal(await input.evaluate((element: Element) => element === document.activeElement), true);
    await page.evaluate(() => (window as any).fixture.regroup("error"));
    await page.locator('section[aria-label="Needs your attention"] .sidebar-activity-item').filter({ hasText: "Fixture thread" }).waitFor();
    assert.equal(await input.inputValue(), "Renamed fixture", "rename draft survives actual task-flow regrouping");
    assert.equal(await input.evaluate((element: Element) => element === document.activeElement), true, "menu cleanup cannot steal dialog focus");
    await invoke(page.getByRole("button", { name: "Save", exact: true }));
    await input.waitFor({ state: "hidden" });
    const renamed = row("Renamed fixture"); await renamed.waitFor();

    // Context menus and dropdowns use the same actions; a held fork follows its row.
    await renamed.click({ button: "right" });
    assert.equal(await page.getByRole("menu").count(), 1);
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Rename", "Create branch", "Archive"]);
    await invoke(page.getByRole("menuitem", { name: "Create branch", exact: true }));
    const busy = page.getByRole("button", { name: "Creating branch for Renamed fixture", exact: true });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    assert.equal(await busy.isDisabled(), true);
    await page.evaluate(() => (window as any).fixture.regroup("ready"));
    await page.getByRole("region", { name: "Recent", exact: true }).getByRole("button").filter({ has: page.getByText("Renamed fixture", { exact: true }) }).waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true", "fork ownership survives a row remount");
    await openActions("Peer thread"); await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).fixture.releaseFork());
    await trigger("Renamed fixture").waitFor();
    await openActions("Renamed fixture");
    await invoke(page.getByRole("menuitem", { name: "Archive", exact: true }));
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), [
      ["rename", "local", "fixture", "Renamed fixture"], ["fork-start", "local", "fixture"],
      ["fork-complete", "local", "fixture"], ["archive", "local", "fixture"],
    ]);
    await invoke(peer);
    assert.equal(await peer.getAttribute("aria-current"), "page");
    assert.equal(await renamed.getAttribute("aria-current"), null);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions.at(-1)), ["select", "local", "peer"]);
    // Authoritative removal ends rename/delete ownership even if another Host
    // still exposes the same Thread ID. Regrouping above keeps draft and focus.
    const actionsBeforeRemoval = await page.evaluate(() => (window as any).fixture.actions.slice());
    await openActions("Renamed fixture");
    await invoke(page.getByRole("menuitem", { name: "Rename", exact: true }));
    await input.fill("Unsubmitted draft");
    await page.evaluate(() => (window as any).fixture.setTargetHost("remote"));
    await input.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog").count(), 0, "removed target closes rename");
    await row("Renamed fixture").waitFor();
    assert.equal(await peer.getAttribute("aria-current"), "page", "target removal does not navigate");
    await page.evaluate(() => { (window as any).fixture.setTargetHost("local"); (window as any).fixture.enableDelete(); });
    await openActions("Renamed fixture", true);
    await invoke(page.getByRole("menuitem", { name: "Delete", exact: true }));
    const deletion = page.getByRole("alertdialog", { name: "Delete conversation", exact: true });
    await deletion.waitFor();
    await page.evaluate(() => (window as any).fixture.regroup("error"));
    assert.equal(await deletion.isVisible(), true, "valid delete survives regrouping");
    await page.evaluate(() => (window as any).fixture.setTargetHost("remote"));
    await deletion.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("alertdialog").count(), 0, "removed target closes delete");
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), actionsBeforeRemoval, "cleanup does not submit stale actions");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: real Sidebar actions across light/dark × desktop/touch; rename draft/focus and held fork survive task-flow regrouping; removed Host/Thread closes rename/delete without submitting; same ID on another Host cannot keep stale modals; menu capabilities, independent touch targets, navigation and current row semantics. Action RPCs synthetic.");
} finally { await browser?.close(); await server.close(); }
