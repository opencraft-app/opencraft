import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// Mount the real Shell and its production CSS, without connecting a Host.
const source = `
import React, {useState} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';
import {ModalSurface} from '/apps/workbench-web/src/components/modal/modal-surface.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const contributionSnapshot={settingsPages:[]};
const contributions={subscribe:()=>()=>{},getSnapshot:()=>contributionSnapshot};
function Demo(){
 const [sidebar,setSidebar]=useState(true),[right,setRight]=useState(false),[full,setFull]=useState(false),[route,setRoute]=useState('Chat');
 const [accountOpen,setAccountOpen]=useState(false),[crowded,setCrowded]=useState(false);
 const [layout,setLayout]=useState('default');
 const [settingsSection,setSettingsSection]=useState('connections');
 window.fixture={setSidebar,setRight,setFull,setRoute,setThemePreference,setCrowded,setLayout};
 const config={settingsActive:route==='Settings',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>setRoute('Chat')},{id:'files',title:'Files',icon:'folder',onInvoke:()=>setRoute('Files')},
 ...(crowded ? Array.from({length:40},(_,i)=>({id:'extra-'+i,title:'Extra application '+(i+1),icon:'folder',onInvoke:()=>{}})) : [])],
 account:{snapshot:{name:'OpenCraft Workspace',phase:'ready',avatarUrl:null,planLabel:'Launch',usageRemainingPercent:69},onOpen:()=>setAccountOpen(true),onRefresh:async()=>{},onSignOut:async()=>{throw Error('test failure')}},onOpenSettings:()=>setRoute('Settings')};
 return <><AppShell navigation={config} layoutScope={route} mainContentLayout={layout}
 header={<AppShellHeader title={null} project={null} sidebarOpen={sidebar} rightPanelOpen={right} rightPanelFullWidth={full}
 onToggleSidebar={()=>setSidebar(v=>!v)} onToggleRightPanel={()=>setRight(v=>!v)} onHome={()=>setRoute('Home')}
 canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['home','sidebar-toggle','back','forward']}/>}
 floatingSidebarHeader={()=>null}
 leftPanel={route === 'Files' ? null : route === 'Settings' ? <SettingsNavigation section={settingsSection} onSectionChange={setSettingsSection} extensionContributions={contributions} profiles={[]} machines={[]} activeHostId="" onBack={()=>setRoute('Chat')} presentation="sidebar"/> : <div className="sidebar-panel"><h3>Conversations</h3><button>First conversation</button><button>Second conversation</button></div>}
 rightPanel={<div>Browser / Terminal</div>} rightPanelOpen={right} rightPanelFullWidth={full} sidebarOpen={sidebar} sidebarWidth={275}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={setRight}>
 <div style={{padding:32}}><h2>{route}</h2>{route==='Settings' ? <p>{settingsSection} content</p> : null}<input aria-label="Draft" defaultValue="Keep my draft"/><button id="outside">Outside</button></div>
 </AppShell>{accountOpen ? <ModalSurface id="test-account" label="Account Settings" onDismiss={()=>setAccountOpen(false)}><input aria-label="Account name" defaultValue="gm"/></ModalSurface> : null}</>;
}
createRoot(document.getElementById('root')).render(<Demo/>);`;

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "shell-navigation-smoke",
    resolveId: id => id === "/probe.tsx" ? id : null,
    load: id => id === "/probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // tsx preserves nested function names through this helper in serialized probes.
  await page.addInitScript("window.__name = (target) => target;");
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await page.waitForSelector("#shell-entrance-applications");
  const home = page.getByRole("button", { name: "Home", exact: true });
  assert.equal(await home.textContent(), "OpenCraft");
  assert.equal(await home.locator("svg").count(), 0, "wordmark replaces the house glyph");
  await home.click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.evaluate(() => (window as any).fixture.setRoute("Chat"));
  assert.equal(await appsOwner(page), true, "entrances belong to the Sidecar, not the viewport");
  // Record identity and geometry on EVERY animation frame, not just endpoints.
  await page.evaluate(() => {
    const nodes = ["applications", "account"].map(s => document.getElementById(`shell-entrance-${s}`)!);
    const parents = nodes.map(n => n.parentNode);
    const rects = nodes.map(n => n.getBoundingClientRect().toJSON());
    const failures: string[] = [];
    (window as any).fixedProbe = { failures, frames: 0, railTransitionFrames: 0, running: true };
    function sample() {
      const probe = (window as any).fixedProbe;
      if (!probe.running) return;
      probe.frames++;
      nodes.forEach((node, i) => {
        const r = node.getBoundingClientRect();
        if (!node.isConnected || node.parentNode !== parents[i]) failures.push("reparented entrance");
        // Only the trailing account edge stretches to fit the first rail.
        for (const key of ["x", "y", "height"] as const) if (Math.abs(r[key] - rects[i][key]) > 0.1) failures.push(`moved ${key}`);
        if (i === 0 && Math.abs(r.width - rects[i].width) > 0.1) failures.push("resized square entrance");
      });
      const width = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      const total = width(".shell-navigation__dock") + width(".app-shell-left-panel") + width(".main-content-surface");
      if (Math.abs(total - width(".app-shell-root")) > 1) failures.push("column geometry exceeds Shell");
      document.querySelectorAll<HTMLElement>("[data-sidecar-pane]").forEach(frame => {
        const viewport = frame.querySelector<HTMLElement>("[data-sidecar-pane-viewport]");
        const clip = frame.querySelector<HTMLElement>("[data-sidecar-pane-clip]");
        if (!viewport || !clip) return failures.push("Sidecar pane missing viewport or clip");
        const frameWidth = frame.getBoundingClientRect().width;
        const viewportWidth = viewport.getBoundingClientRect().width;
        if (Math.abs(clip.getBoundingClientRect().width - frameWidth) > 1)
          failures.push("Sidecar clip escaped its frame");
        if (frameWidth > 1 && viewportWidth - frameWidth > 1) {
          probe.railTransitionFrames++;
          if (viewportWidth < 167) failures.push("rail content reflowed during transition");
          const opacity = Number.parseFloat(getComputedStyle(viewport).opacity);
          const widthProgress = frameWidth / viewportWidth;
          if (opacity - widthProgress > 0.08)
            failures.push(`rail content did not share geometry progress (${frame.className}; ${frameWidth}/${viewportWidth}; ${opacity})`);
        }
      });
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  const apps = page.locator("#shell-entrance-applications");
  const account = page.locator("#shell-entrance-account");
  assert.equal(await apps.getAttribute("aria-pressed"), "true");
  await apps.click();
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLElement>(".shell-navigation__dock");
    if (!frame) return false;
    const width = frame.getBoundingClientRect().width;
    return width > 20 && width < 170;
  });
  const transition = await page.locator(".shell-navigation__dock").evaluate((frame: HTMLElement) => {
    const viewport = frame.querySelector<HTMLElement>("[data-sidecar-pane-viewport]")!;
    return {
      frameWidth: frame.getBoundingClientRect().width,
      opacity: Number.parseFloat(getComputedStyle(viewport).opacity),
      viewportWidth: viewport.getBoundingClientRect().width,
    };
  });
  assert.ok(transition.viewportWidth >= 181.9, "application content keeps its destination width while the frame collapses");
  assert.ok(transition.opacity > 0 && transition.opacity < 1, "application content fades on the same transition timeline");
  assert.ok(transition.frameWidth < transition.viewportWidth, "only the outer frame participates in layout interpolation");
  await page.screenshot({ path: "/tmp/opencraft-sidecar-pane-transition.png" });
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  await apps.click();
  await page.waitForFunction(() => (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 181.9);
  assert.equal(await page.getByRole("dialog", { name: "Applications", exact: true }).count(), 0, "wide application toggle never opens a menu");
  assert.equal(await page.getByRole("button", { name: "Pin Applications", exact: true }).count(), 0);
  await page.waitForFunction(() => document.activeElement?.id === "shell-entrance-applications");
  // Rapid reversals use the existing spring, preserve the Shell and never peek.
  for (let index = 0; index < 6; index++) {
    await apps.click({ force: true });
    assert.equal(await apps.getAttribute("aria-pressed"), String(index % 2 !== 0));
    assert.equal(await page.getByRole("dialog", { name: "Applications", exact: true }).count(), 0);
  }
  await page.waitForFunction(() => (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 181.9);
  await page.locator(".shell-navigation__dock").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Back to app", exact: true }).count(), 0);
  assert.equal(await page.locator(".app-shell-root").count(), 1, "Settings replaces slots, not the Shell");
  assert.equal(await page.locator(".shell-navigation__dock").getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-current"), "page");
  await assertFooterFill(page);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByText("appearance content", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/opencraft-settings-shared-shell.png" });
  await page.locator(".shell-navigation__dock").getByRole("button", { name: "Chat", exact: true }).click();
  assert.equal(await page.getByLabel("Draft", { exact: true }).inputValue(), "Keep my draft");
  const accountLabelX = await account.locator(".shell-navigation__name").evaluate((node: HTMLElement) =>
    node.getBoundingClientRect().x);
  await account.click();
  assert.equal(await account.locator(".shell-navigation__name").evaluate((node: HTMLElement) =>
    node.getBoundingClientRect().x), accountLabelX,
  "opening the account surface cannot change the Footer trigger's internal geometry");
  assert.deepEqual(await page.locator(".shell-navigation__peek .sidebar-account__avatar").evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return { width: style.width, height: style.height, flexBasis: style.flexBasis };
  }), { width: "28px", height: "28px", flexBasis: "28px" },
  "the account surface owns a bounded avatar slot independent of entrance animation");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "shell-entrance-account");
  await account.click();
  await page.getByRole("button", { name: "Pin Account", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__peek"));
  assert.equal(await apps.getAttribute("aria-pressed"), "true");
  assert.equal(await account.getAttribute("aria-pressed"), "true");
  await account.click();
  await account.click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.locator("#outside").click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__peek"));
  await account.click();
  await page.getByRole("dialog", { name: "Account", exact: true }).getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("dialog", { name: "Account Settings", exact: true }).waitFor();
  await page.waitForTimeout(160);
  assert.ok(await page.evaluate(() => document.activeElement?.closest(".modal-surface") !== null), "account modal owns focus after the navigation peek closes");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".modal-surface"));
  const probe = await page.evaluate(() => { (window as any).fixedProbe.running = false; return (window as any).fixedProbe; });
  assert.deepEqual(probe.failures, []);
  assert.ok(probe.frames > 30);
  assert.ok(probe.railTransitionFrames > 4, "the probe observed stable content planes during intermediate rail frames");
  await page.evaluate(() => { (window as any).fixture.setSidebar(false); (window as any).fixture.setRight(true); });
  await page.waitForFunction(() => !document.querySelector(".app-shell-left-panel"));
  await page.evaluate(() => { (window as any).fixture.setFull(true); (window as any).fixture.setRoute("Files"); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { (window as any).fixture.setFull(false); (window as any).fixture.setRight(false); (window as any).fixture.setSidebar(true); (window as any).fixture.setRoute("Chat"); });
  await page.waitForTimeout(600);
  assert.equal(await page.getByLabel("Draft", { exact: true }).inputValue(), "Keep my draft");
  await page.screenshot({ path: process.env.OPENCRAFT_SHELL_SCREENSHOT ?? "/tmp/opencraft-shell-navigation.png" });
  // Width pressure only suspends presentation, never the persisted pin.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  assert.equal(await apps.getAttribute("data-pinned"), "true");
  assert.equal(await apps.getAttribute("aria-pressed"), "false", "compact entry reflects drawer visibility, not the suspended pin");
  await apps.click();
  await page.getByRole("dialog", { name: "Applications", exact: true }).waitFor();
  assert.equal(await page.locator(".shell-navigation__drawer").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Pin Applications", exact: true }).count(), 0);
  assert.equal(await apps.getAttribute("aria-expanded"), "true");
  await apps.click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__drawer"));
  await apps.click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 181.9);
  await page.evaluate(() => (window as any).fixture.setThemePreference("dark"));
  await account.click();
  await page.waitForTimeout(160);
  await page.screenshot({ path: "/tmp/opencraft-shell-navigation-dark.png" });
  await page.keyboard.press("Escape");
  // Both left columns closed: no orphan entrance, no window-wide bottom strip.
  await apps.click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  await page.evaluate(() => (window as any).fixture.setSidebar(false));
  await page.waitForFunction(() => !document.querySelector(".app-shell-left-panel"));
  assert.equal(await apps.isVisible(), false);
  const heights = await page.evaluate(() => [".app-shell-root", ".main-content-surface"].map(selector => document.querySelector(selector)!.getBoundingClientRect().height));
  assert.equal(heights[0], heights[1], "content uses full window height when Sidecar is closed");
  await page.screenshot({ path: "/tmp/opencraft-sidecar-collapsed.png" });
  await page.mouse.move(1, 400);
  const floatingApps = page.locator("#floating-shell-entrance-applications");
  await floatingApps.waitFor({ state: "visible" });
  await floatingApps.click();
  await page.waitForFunction(() => (document.querySelector(".app-shell-left-panel")?.getBoundingClientRect().width ?? 0) >= 274.9);
  assert.equal(await apps.getAttribute("aria-pressed"), "true", "pinning from the transient sidebar also docks its owner");
  await apps.click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  await page.mouse.move(1000, 400);
  await page.waitForFunction(() => !document.querySelector(".app-shell-floating-left-panel"));
  await page.evaluate(() => (window as any).fixture.setSidebar(true));
  await apps.waitFor({ state: "visible" });
  await apps.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForSelector("#shell-entrance-applications");
  assert.equal(await apps.getAttribute("aria-pressed"), "true");
  await apps.click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  // An application without a context list occupies only the primary rail.
  await page.evaluate(() => (window as any).fixture.setRoute("Files"));
  await page.waitForFunction(() => !document.querySelector(".app-shell-left-panel") && (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 181.9);
  await assertFooterFill(page);
  assert.equal(await page.getByText("Conversations", { exact: true }).count(), 0);
  await page.screenshot({ path: "/tmp/opencraft-sidecar-context-free.png" });
  await apps.click();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  assert.equal(await apps.isVisible(), false);
  await page.mouse.move(1, 400);
  await floatingApps.waitFor({ state: "visible" });
  await floatingApps.click();
  await page.waitForFunction(() => (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 181.9);
  assert.equal(await page.getByText("Conversations", { exact: true }).count(), 0);
  await page.mouse.move(1000, 400);
  // Framer Motion initializes its reduced-motion preference once per page.
  // Reload under the normal preference before validating spring frames.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await page.waitForSelector("#shell-entrance-applications");
  await page.evaluate(() => { (window as any).fixture.setRoute("Chat"); (window as any).fixture.setSidebar(true); });
  await page.waitForFunction(() => (document.querySelector(".app-shell-left-panel")?.getBoundingClientRect().width ?? 0) >= 274.9);
  assert.equal(await apps.getAttribute("aria-pressed"), "false", "returning to Chat restores its unpinned layout");
  await apps.click();
  const resizeApps = page.getByRole("separator", { name: "Resize applications", exact: true });
  await resizeApps.waitFor();
  await page.waitForFunction(() => Math.abs((document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) - 182) < 0.1);
  const entranceBeforeResize = await apps.boundingBox();
  const accountBeforeResize = await account.boundingBox();
  const handle = await resizeApps.boundingBox();
  assert.equal(await resizeApps.evaluate((node: HTMLElement) => {
    const box = node.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, 250) === node;
  }), true, "application divider owns its pointer hit target");
  await page.mouse.move(handle!.x + handle!.width / 2, 250);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 80, 250, { steps: 8 });
  const liveExpansion = await page.locator(".shell-navigation__dock").evaluate((frame: HTMLElement) => ({
    frame: frame.getBoundingClientRect().width,
    viewport: frame.querySelector<HTMLElement>("[data-sidecar-pane-viewport]")!.getBoundingClientRect().width,
    item: frame.querySelector<HTMLElement>(".shell-navigation__items > button")!.getBoundingClientRect().width,
  }));
  assert.ok(Math.abs(liveExpansion.frame - liveExpansion.viewport) < 0.1,
    `rightward pointer frames and painted viewport move together: ${JSON.stringify(liveExpansion)}`);
  assert.ok(Math.abs(liveExpansion.item - (liveExpansion.frame - 24)) < 0.1,
    "the selected row fills the live expanded viewport without a trailing blank shelf");
  await assertFooterFill(page);
  await page.mouse.up();
  assert.equal(await resizeApps.getAttribute("aria-valuenow"), "262");
  assert.deepEqual(await apps.boundingBox(), entranceBeforeResize, "resizing preserves the footer anchor and square size");
  await assertFooterFill(page);
  assert.equal(await page.getByRole("separator", { name: "Resize sidebar", exact: true }).getAttribute("aria-valuenow"), "275");
  await resizeApps.focus();
  await page.keyboard.press("End");
  assert.equal(await resizeApps.getAttribute("aria-valuenow"), "520");
  await assertFooterFill(page);
  await resizeApps.dblclick();
  assert.equal(await resizeApps.getAttribute("aria-valuenow"), "182");
  await page.waitForFunction(() =>
    Math.abs((document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) - 182) < 0.1
    && Math.abs((document.querySelector(".app-shell-sidecar__footer")?.getBoundingClientRect().width ?? 0) - 260) < 0.1,
  );
  await page.waitForTimeout(550);
  const entranceBeforeDetentDrag = await apps.boundingBox();
  const accountBeforeDetentDrag = await account.boundingBox();

  // The first magnetic shelf is a semantic icon rail, not crushed labels.
  let detentHandle = await resizeApps.boundingBox();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2, 250);
  await page.mouse.down();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2 - 120, 250, { steps: 8 });
  assert.equal(await page.locator(".app-shell-root").getAttribute("data-sidecar-primary-detent"), "expanded",
    "pointer preview never mutates the committed Sidecar detent");
  const heldPrimaryGeometry = await page.locator(".shell-navigation__dock").evaluate((frame: HTMLElement) => {
    const clip = frame.querySelector<HTMLElement>("[data-sidecar-pane-clip]")!.getBoundingClientRect();
    const viewport = frame.querySelector<HTMLElement>("[data-sidecar-pane-viewport]")!;
    const viewportRect = viewport.getBoundingClientRect();
    const firstItem = frame.querySelector<HTMLElement>(".shell-navigation__items > button")!;
    const firstLabel = firstItem.querySelector<HTMLElement>(".shell-navigation__item-label")!;
    return {
      frame: frame.getBoundingClientRect().width,
      clip: clip.width,
      item: firstItem.getBoundingClientRect().width,
      labelOpacity: Number.parseFloat(getComputedStyle(firstLabel).opacity),
      opacity: Number.parseFloat(getComputedStyle(viewport).opacity),
      viewport: viewportRect.width,
    };
  });
  assert.equal(heldPrimaryGeometry.frame, heldPrimaryGeometry.clip,
    "the Clip follows the live Primary frame");
  assert.ok(heldPrimaryGeometry.frame > 52 && heldPrimaryGeometry.frame < 168,
    `a held pointer frame remains continuous between magnetic detents: ${JSON.stringify(heldPrimaryGeometry)}`);
  assert.deepEqual(
    { opacity: heldPrimaryGeometry.opacity, viewport: heldPrimaryGeometry.viewport },
    { opacity: 1, viewport: 182 },
    "held pointer motion does not fade or resize the painted Viewport",
  );
  assert.ok(heldPrimaryGeometry.item < heldPrimaryGeometry.frame
    && heldPrimaryGeometry.labelOpacity >= 0
    && heldPrimaryGeometry.labelOpacity < 0.5,
    "selection geometry contracts and its label fades before either can be hard-clipped");
  assert.equal(await page.getByRole("button", { name: "Chat", exact: true }).isVisible(), true,
    "the Primary action remains painted throughout the held drag");
  assert.deepEqual(await apps.boundingBox(), entranceBeforeDetentDrag,
    "the Footer entrance is not a consumer of pointer preview width");
  assert.deepEqual(await account.boundingBox(), accountBeforeDetentDrag,
    "the account entrance remains fixed during the pointer transaction");
  await page.screenshot({ path: "/tmp/opencraft-navigation-held-motion.png" });
  await page.mouse.up();
  const settleFrames = await page.evaluate(async () => {
    const frames: number[] = [];
    for (let frame = 0; frame < 18; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      frames.push(document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0);
    }
    return frames;
  });
  assert.ok(new Set(settleFrames.map(width => width.toFixed(2))).size > 2,
    `release plays a physical detent settle instead of snapping one frame: ${settleFrames.join(", ")}`);
  assert.ok(settleFrames[0]! > settleFrames.at(-1)! && Math.abs(settleFrames.at(-1)! - 52) < 1,
    "the release spring converges from the pointer frame to the compact shelf");
  await page.waitForFunction(() => Math.abs((document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) - 52) < 0.1);
  assert.equal(await resizeApps.getAttribute("aria-valuetext"), "Compact");
  assert.equal(await page.locator(".app-shell-root").getAttribute("data-sidecar-primary-detent"), "compact");
  assert.equal(await page.getByRole("button", { name: "Chat", exact: true }).evaluate((node: HTMLElement) => {
    const label = node.querySelector<HTMLElement>(".shell-navigation__item-label");
    return label != null && Number.parseFloat(getComputedStyle(label).opacity) === 0;
  }), true, "compact rail projects icon-only actions");
  assert.deepEqual(await page.getByRole("button", { name: "Chat", exact: true }).evaluate((node: HTMLElement) => {
    const row = node.getBoundingClientRect();
    const icon = node.querySelector("svg")!.getBoundingClientRect();
    return {
      row: [row.width, row.height],
      centerOffset: (icon.left + icon.width / 2) - (row.left + row.width / 2),
    };
  }), { row: [34, 34], centerOffset: 0 },
  "compact navigation presents a centered square selection surface");
  await page.waitForTimeout(50);
  const compactOpacity = await page.locator(".shell-navigation__viewport").evaluate((node: HTMLElement) => ({
    opacity: Number.parseFloat(getComputedStyle(node).opacity),
    open: node.closest("[data-sidecar-pane]")?.getAttribute("data-sidecar-pane-open"),
    width: Math.round(node.closest("[data-sidecar-pane]")?.getBoundingClientRect().width ?? 0),
  }));
  assert.deepEqual(compactOpacity, { opacity: 1, open: "true", width: 52 },
  "the committed compact projection is fully painted after the transaction");
  for (const action of ["home", "sidebar-toggle", "back", "forward"]) {
    assert.equal(await page.locator(`.app-shell-header__window-controls [data-app-shell-window-action="${action}"]`).isVisible(), true,
      `compact Sidecar does not remove the global ${action} action`);
  }
  const entranceAfterCompact = await apps.boundingBox();
  const accountAfterCompact = await account.boundingBox();
  assert.equal(await account.locator(".shell-navigation__name").isVisible(), true,
    "Primary compact mode never creates a compact Footer projection");
  assert.equal(await page.locator(".app-shell-sidecar__footer").evaluate((node: HTMLElement) =>
    node.getBoundingClientRect().width), 260,
  "Footer retains its own preferred width while the Primary Pane is compact");
  assert.deepEqual(
    { x: entranceAfterCompact!.x, y: entranceAfterCompact!.y, width: entranceAfterCompact!.width, height: entranceAfterCompact!.height },
    { x: entranceBeforeResize!.x, y: entranceBeforeResize!.y, width: entranceBeforeResize!.width, height: entranceBeforeResize!.height },
    "the application entrance keeps its exact Sidecar Footer frame",
  );
  assert.deepEqual(
    { x: accountAfterCompact!.x, y: accountAfterCompact!.y, height: accountAfterCompact!.height },
    { x: accountBeforeResize!.x, y: accountBeforeResize!.y, height: accountBeforeResize!.height },
    "the account entrance keeps its column origin while only trailing space may change",
  );
  assert.equal(await page.locator(".shell-navigation__dock").evaluate((node: HTMLElement) => {
    const pane = node.getBoundingClientRect();
    const divider = getComputedStyle(node, "::before");
    return Number.parseFloat(divider.top) > 0 && Number.parseFloat(divider.top) >= 40
      && getComputedStyle(node).borderRightWidth === "0px" && Math.abs(pane.width - 52) < 0.1;
  }), true, "the pane divider starts below the global Header and does not own Footer geometry");
  await page.screenshot({ path: "/tmp/opencraft-navigation-compact-detent.png" });

  // A second drag crosses the release threshold and hides the whole rail.
  detentHandle = await resizeApps.boundingBox();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2, 250);
  await page.mouse.down();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2 - 50, 250, { steps: 6 });
  assert.equal(await page.locator(".app-shell-root").getAttribute("data-sidecar-primary-detent"), "compact",
    "the second preview also preserves its committed origin until release");
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
  assert.equal(await apps.getAttribute("aria-pressed"), "false");

  // Reopening returns to the remembered icon shelf; dragging right escapes it
  // to the expanded minimum without destroying the earlier width preference.
  await apps.click();
  await page.waitForFunction(() => Math.abs((document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) - 52) < 0.1);
  detentHandle = await resizeApps.boundingBox();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2, 250);
  await page.mouse.down();
  await page.mouse.move(detentHandle!.x + detentHandle!.width / 2 + 100, 250, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => Math.abs((document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) - 168) < 0.1);
  assert.equal(await page.locator(".app-shell-root").getAttribute("data-sidecar-primary-detent"), "expanded");
  await resizeApps.focus();
  await page.keyboard.press("ArrowRight");
  await page.reload();
  await resizeApps.waitFor();
  assert.equal(await resizeApps.getAttribute("aria-valuenow"), "178", "application width and expanded shelf survive reload");
  const appsBox = await apps.boundingBox(), accountBox = await account.boundingBox();
  assert.equal(appsBox!.width, appsBox!.height, "application entrance is square");
  assert.equal(accountBox!.width, 260 - 24 - appsBox!.width, "account fills all remaining Footer width");
  const accountNameGeometry = await account.locator(".shell-navigation__name").evaluate((node: HTMLElement) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  assert.ok(accountNameGeometry.scrollWidth <= accountNameGeometry.clientWidth,
    `a normal account name remains readable in the narrower Footer: ${JSON.stringify(accountNameGeometry)}`);
  await assertFooterFill(page);
  await page.mouse.move(1000, 400);
  assert.notEqual(await apps.evaluate((node: HTMLElement) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "pin retains a quiet selected fill after pointer leaves");
  assert.equal(await apps.evaluate((node: HTMLElement) => getComputedStyle(node).boxShadow), "none");
  await page.locator(".shell-navigation__footer").screenshot({ path: "/tmp/opencraft-compact-entrance.png" });
  // A short window (e.g. docked DevTools) must reserve actual footer space,
  // not rely on padding under a transparent absolute overlay.
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((theme: string) => (window as any).fixture.setThemePreference(theme), theme);
    await page.setViewportSize({ width: 1440, height: 260 });
    await assertFooterTrack(page);
    // Theme changes also repaint inherited foregrounds; do not capture the
    // previous theme's ink during the browser's transition frame.
    await page.waitForFunction((theme: string) => {
      const color = getComputedStyle(document.querySelector(".shell-navigation__items > button")!).color;
      const red = Number(color.match(/^rgba?\((\d+)/)?.[1]);
      return theme === "dark" ? red > 200 : red < 80;
    }, theme);
    const pinnedSurface = await apps.evaluate((node: HTMLElement) => getComputedStyle(node).backgroundColor);
    assert.notEqual(pinnedSurface, "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: `/tmp/opencraft-footer-pinned-${theme}.png` });
    await apps.click();
    await page.mouse.move(1000, 100);
    await page.waitForFunction(() => !document.querySelector(".shell-navigation__dock"));
    assert.equal(await apps.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("shell-entrance-applications")!).backgroundColor === "rgba(0, 0, 0, 0)");
    for (const item of [apps, account]) {
      assert.deepEqual(await item.evaluate((node: HTMLElement) => {
        const style = getComputedStyle(node);
        return [style.backgroundColor, style.boxShadow, style.borderTopWidth];
      }), ["rgba(0, 0, 0, 0)", "none", "0px"], "resting sidebar items have no card chrome");
    }
    await assertFooterFill(page);
    await assertFooterTrack(page);
    await page.screenshot({ path: `/tmp/opencraft-footer-unpinned-${theme}.png` });
    await account.hover();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("shell-entrance-account")!).backgroundColor !== "rgba(0, 0, 0, 0)");
    assert.equal(await account.evaluate((node: HTMLElement) => getComputedStyle(node).boxShadow), "none");
    await page.locator(".app-shell-sidecar > .app-shell-sidecar__footer").screenshot({ path: `/tmp/opencraft-footer-hover-${theme}.png` });
    await account.click();
    await page.mouse.move(1000, 100);
    assert.equal(await account.getAttribute("data-state"), "open");
    assert.equal(await account.getAttribute("aria-pressed"), "false", "opening an item does not pin it");
    assert.notEqual(await account.evaluate((node: HTMLElement) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("shell-entrance-account")!).backgroundColor === "rgba(0, 0, 0, 0)");
    await apps.click();
    await page.waitForFunction(() => (document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0) >= 167.9);
    await page.evaluate(() => (window as any).fixture.setCrowded(true));
    const list = page.locator(".shell-navigation__dock-content");
    assert.ok(await list.evaluate((node: HTMLElement) => node.scrollHeight > node.clientHeight), "long navigation scrolls above the footer");
    await list.evaluate((node: HTMLElement) => { node.scrollTop = node.scrollHeight; });
    await assertFooterTrack(page);
    const last = await page.getByRole("button", { name: "Extra application 40", exact: true }).boundingBox();
    const footer = await page.locator(".app-shell-sidecar > .app-shell-sidecar__footer").boundingBox();
    assert.ok(last!.y + last!.height <= footer!.y, "last navigation action is reachable without going under footer");
    await page.evaluate(() => (window as any).fixture.setCrowded(false));
  }
  await page.evaluate(() => (window as any).fixture.setSidebar(false));
  await page.waitForFunction(() => !document.querySelector(".app-shell-left-panel") && !document.querySelector(".shell-navigation__dock"));
  await page.mouse.move(1, 100);
  await floatingApps.waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    (document.querySelector(".app-shell-floating-left-panel")?.getBoundingClientRect().width ?? 0) >= 274.9,
  );
  await page.waitForTimeout(550);
  const floatingTrack = await page.locator(".app-shell-floating-left-panel .app-shell-sidecar__footer").boundingBox();
  const floatingBody = await page.locator(".app-shell-floating-left-panel__body").boundingBox();
  assert.ok(floatingTrack!.height >= 58 && floatingBody!.y + floatingBody!.height <= floatingTrack!.y + 0.1,
    "transient sidebar owns the same non-overlapping footer track in a short window");
  const floatingAppBox = await floatingApps.boundingBox();
  const floatingAccountBox = await page.locator("#floating-shell-entrance-account").boundingBox();
  assert.ok(Math.abs(floatingAppBox!.width - floatingAppBox!.height) < 0.01);
  assert.ok(Math.abs(floatingTrack!.x + floatingTrack!.width - floatingAccountBox!.x - floatingAccountBox!.width - 12) < 0.5,
    "floating account item fills its rail too");
  await page.mouse.move(1000, 100);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await apps.waitFor();
  await page.evaluate(() => { (window as any).fixture.setLayout("thread-edge-scroll"); (window as any).fixture.setSidebar(true); });
  for (const width of [1535, 1536, 1537]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(450);
    const changes = await page.evaluate(async () => {
      const frame = document.querySelector(".main-content-frame")!;
      const values = [frame.getAttribute("data-app-shell-thread-edge-divider")];
      const observer = new MutationObserver(() => values.push(frame.getAttribute("data-app-shell-thread-edge-divider")));
      observer.observe(frame, { attributes: true, attributeFilter: ["data-app-shell-thread-edge-divider"] });
      for (let i = 0; i < 6; i++) {
        (window as any).fixture.setSidebar(i % 2 !== 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 450));
      observer.disconnect();
      return values;
    });
    assert.deepEqual([...new Set(changes)], [String(width < 1536)], `left sidebar motion cannot toggle header divider at ${width}px`);
    const divider = page.getByRole("separator", { name: "Resize applications", exact: true });
    const dragBox = await divider.boundingBox();
    await page.evaluate(() => {
      const frame = document.querySelector(".main-content-frame")!;
      const values = [frame.getAttribute("data-app-shell-thread-edge-divider")];
      const observer = new MutationObserver(() => values.push(frame.getAttribute("data-app-shell-thread-edge-divider")));
      observer.observe(frame, { attributes: true, attributeFilter: ["data-app-shell-thread-edge-divider"] });
      (window as any).dividerProbe = { values, observer };
    });
    const x = dragBox!.x + dragBox!.width / 2;
    await page.mouse.move(x, 250);
    await page.mouse.down();
    await page.mouse.move(x + 73, 250, { steps: 20 });
    await page.mouse.move(x, 250, { steps: 20 });
    await page.mouse.up();
    const dragChanges = await page.evaluate(() => {
      (window as any).dividerProbe.observer.disconnect();
      return (window as any).dividerProbe.values;
    });
    assert.deepEqual([...new Set(dragChanges)], [String(width < 1536)], `drag resizing cannot toggle header divider at ${width}px`);
  }
  await page.evaluate(() => (window as any).fixture.setRight(true));
  await page.waitForFunction(() => document.querySelector(".main-content-frame")?.getAttribute("data-app-shell-thread-edge-divider") === "true");
  await page.evaluate(() => (window as any).fixture.setRight(false));
  await page.waitForFunction(() => document.querySelector(".main-content-frame")?.getAttribute("data-app-shell-thread-edge-divider") === "false");
  assert.deepEqual(errors, []);
  console.log(`Shell navigation passed: ${probe.frames} fixed-anchor frames, rapid application toggles, Settings slot replacement, compact drawer, independent account menu, focus/Escape/outside press, route/draft retention, footer material/fill, resizing, persistence, dark mode and reduced motion.`);
} finally { await browser?.close(); await vite.close(); }

async function appsOwner(page: any) {
  return page.locator("#shell-entrance-applications").evaluate((node: HTMLElement) => node.closest(".app-shell-sidecar") !== null);
}

async function assertFooterFill(page: any) {
  const layout = await page.evaluate(() => {
    const rail = document.querySelector(".shell-navigation__dock") ?? document.querySelector(".app-shell-left-panel");
    const railBox = rail!.getBoundingClientRect();
    const footerBox = document.querySelector(".app-shell-sidecar__footer")!.getBoundingClientRect();
    const apps = document.getElementById("shell-entrance-applications")!.getBoundingClientRect();
    const account = document.getElementById("shell-entrance-account")!.getBoundingClientRect();
    return { left: apps.left - railBox.left, right: footerBox.right - account.right,
      footerWidth: footerBox.width, railWidth: railBox.width,
      gap: account.left - apps.right, square: apps.width - apps.height };
  });
  assert.ok(Math.abs(layout.left - 12) < 0.1 && layout.right >= 11.9,
    `entrances retain the Sidecar origin and never overflow its trailing edge: ${JSON.stringify(layout)}`);
  assert.equal(layout.gap, 0);
  assert.equal(layout.square, 0);
}

async function assertFooterTrack(page: any) {
  const layout = await page.evaluate(() => {
    const track = document.querySelector(".app-shell-sidecar > .app-shell-sidecar__footer")!.getBoundingClientRect();
    const rails = document.querySelector(".app-shell-sidecar__panes")!.getBoundingClientRect();
    const button = document.getElementById("shell-entrance-applications")!;
    const rect = button.getBoundingClientRect();
    return { trackHeight: track.height, trackTop: track.top, railsBottom: rails.bottom,
      footerBackground: getComputedStyle(document.querySelector(".app-shell-sidecar > .app-shell-sidecar__footer")!).backgroundColor,
      railBackground: getComputedStyle(document.querySelector(".shell-navigation__dock") ?? document.querySelector(".app-shell-left-panel")!).backgroundColor,
      buttonTop: rect.top, ownsHit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  });
  assert.ok(layout.trackHeight >= 58, "footer owns physical layout height");
  assert.ok(layout.railsBottom <= layout.trackTop + 0.1, "scrollable rails cannot overlap footer");
  assert.ok(layout.buttonTop >= layout.trackTop);
  assert.equal(layout.ownsHit, true);
  assert.equal(layout.footerBackground, "rgba(0, 0, 0, 0)", "Footer uses the Sidecar material, not a separate surface");
  assert.equal(layout.railBackground, layout.footerBackground, "rails and Footer share one material owner");
}
