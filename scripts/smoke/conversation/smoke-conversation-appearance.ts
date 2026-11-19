import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-conversation-appearance";
const source = `
import React,{useEffect,useMemo,useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {EditableThreadTitle} from '/apps/workbench-web/src/components/editable-thread-title.tsx';
import {ConversationTaskMenu} from '/apps/workbench-web/src/components/conversation-task-menu.tsx';
import {ConversationAppearanceProvider,ConversationAppearanceButton,ConversationAppearanceIcon} from '/apps/workbench-web/src/components/conversation-appearance.tsx';
import {useUiPreferencesRuntime,UiPreferencesProvider} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {IndexedDbUiPreferenceStore} from '/apps/workbench-web/src/runtime/indexeddb-ui-preference-store.ts';
import {UiPreferencesRuntime} from '@opencraft/ui-preferences';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const store=await IndexedDbUiPreferenceStore.open({databaseName:'appearance-fixture'});
const preferences=await UiPreferencesRuntime.open({installation:store});
const persist=store.compareAndSet.bind(store);let fail=false,release=null;store.compareAndSet=async(...args)=>{if(fail)throw Error('synthetic failure');if(release===true)await new Promise(resolve=>release=resolve);return persist(...args)};
const noop=()=>{};const threads=['investment','writing'].map((id,i)=>({id,title:i?'Writing':'Investment',project:'Workspace',status:i?'ready':'running',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,value)=>value});
function App(){const [scope,setScope]=useState('alice');const [route,setRoute]=useState('investment');const [sidebar,setSidebar]=useState(true);const title=threads.find(t=>t.id===route).title;
window.fixture={preferences,setScope,setRoute,setSidebar,setThemePreference,setAppearanceThemeId,fail:value=>fail=value,hold:()=>release=true,release:()=>{const done=release;release=null;done?.()}};
return <ConversationAppearanceProvider scope={scope} routeKey={route}><AppShell navigation={{layout:'unified',actions:[],onOpenSettings:noop,account:{snapshot:{phase:'anonymous'},onOpen:noop}}}
 layoutScope='appearance' mainContentLayout='default' sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={noop}
 rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} floatingSidebarHeader={()=>null}
 leftPanel={<Sidebar threads={threads} activeHostId='local' activeThreadId={route} sidebarLayout={layout} onSelectThread={(_host,id)=>setRoute(id)} onNewTask={noop} onOpenSettings={noop} showFooter={false}
 threadActions={{onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{}}} threadCapabilities={()=>({rename:true,archive:true,delete:true,fork:true})}/>}
 header={<AppShellHeader conversationHeader title={title} project='Workspace' primaryActionFixedSlots={1}
 titleContent={<span className='conversation-appearance-heading'><ConversationAppearanceButton hostId='local' threadId={route} title={title}/><EditableThreadTitle title={title} project='Workspace' onRename={async()=>{}}/></span>}
 primaryAction={<ConversationTaskMenu scope={scope} serverId='local' appearanceHostId='local' threadId={route} title={title} onRename={async()=>{}} verifyConversation={async()=>{}} onOpenTasks={noop}/>}
 sidebarOpen={sidebar} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setSidebar(v=>!v)} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle']}/>}
 ><div style={{padding:24}}><h1>{title}</h1><textarea aria-label='Draft' defaultValue='Keep my draft'/><div data-appearance-card><ConversationAppearanceIcon hostId='local' threadId={route}/>{title}</div></div></AppShell></ConversationAppearanceProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<UiPreferencesProvider runtime={preferences}><QueryClientProvider client={new QueryClient()}><App/></QueryClientProvider></UiPreferencesProvider>);
`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-appearance-stable",
  esbuild: { jsx: "automatic" },
  optimizeDeps: {
    entries: [],
    noDiscovery: true,
    include: [
      "@deepseek-ai/cordis",
      "@radix-ui/react-slot",
      "@radix-ui/react-compose-refs",
      "@radix-ui/react-alert-dialog",
      "react-dom",
      "react/jsx-dev-runtime",
      "react-use-event-hook",
      "tslib",
      "hoist-non-react-statics",
      "react-is",
      "scheduler",
      "react",
      "react-dom/client",
      "react/jsx-runtime",
      "@tanstack/react-query",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-tooltip",
      "motion/react",
      "framer-motion",
      "react-intl",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "sonner",
    ],
  },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "appearance-fixture",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  if (process.env.OPENCRAFT_SMOKE_LOCALE_ONLY !== "1")
    for (const testCase of [
      { width: 1440, touch: false, theme: "light" },
      { width: 1440, touch: false, theme: "dark" },
      { width: 390, touch: true, theme: "light" },
      { width: 390, touch: true, theme: "dark" },
      { width: 1024, touch: true, theme: "lavender" },
    ]) {
      console.log("CASE", testCase);
      const context = await browser.newContext({
        viewport: { width: testCase.width, height: 850 },
        hasTouch: testCase.touch,
        isMobile: testCase.width < 600,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log(error.stack);
      });
      await page.addInitScript("window.__name = target => target");
      await page.goto(vite.resolvedUrls!.local[0]!);
      await page.getByRole("textbox", { name: "Draft", exact: true }).waitFor({ timeout: 90000 });
      await page.evaluate(({ theme }) => {
        const f = (window as any).fixture;
        f.setSidebar(false);
        f.setThemePreference(theme === "dark" ? "dark" : "light");
        if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender");
      }, testCase);
      const click = async (locator: any) => (testCase.touch ? locator.tap() : locator.click());
      await click(page.getByRole("button", { name: "Change icon", exact: true }));
      const dialog = page.getByRole("dialog", { name: "Conversation icon" });
      await dialog.waitFor();
      await click(dialog.getByRole("button", { name: "Purple", exact: true }));
      await page.waitForFunction(() =>
        document.querySelector('.conversation-appearance-trigger [data-color="purple"]'),
      );
      await click(dialog.getByRole("button", { name: "Chart", exact: true }));
      await page.waitForFunction(() => document.querySelector('.conversation-appearance-trigger [data-icon="chart"]'));
      assert.equal(await page.locator('[data-appearance-card] [data-icon="chart"]').count(), 1);
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= testCase.width + 1);
      const controls = await dialog.locator("button").evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().width)
          .map((n) => {
            const r = n.getBoundingClientRect();
            return { x: r.x, right: r.right, bottom: r.bottom };
          }),
      );
      assert.ok(controls.every((r) => r.x >= 0 && r.right <= testCase.width + 1 && r.bottom <= 851));
      await page.screenshot({ path: `${output}/${testCase.width}-${testCase.theme}.png` });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "Keep my draft");
      if (!testCase.touch)
        assert.equal(
          await page
            .getByRole("button", { name: "Change icon", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
      await page.reload();
      await page.getByRole("textbox", { name: "Draft" }).waitFor();
      await page.evaluate(() => (window as any).fixture.setSidebar(false));
      await page.locator('.conversation-appearance-trigger [data-icon="chart"][data-color="purple"]').waitFor();
      await page.evaluate(() => (window as any).fixture.setScope("bob"));
      await page.locator('.conversation-appearance-trigger [data-icon="chat"][data-color="default"]').waitFor();
      await page.evaluate(() => (window as any).fixture.setScope("alice"));
      await page.locator('.conversation-appearance-trigger [data-icon="chart"]').waitFor();
      await click(page.getByRole("button", { name: "Conversation actions", exact: true }));
      await click(page.getByRole("menuitem", { name: "Change icon", exact: true }));
      await dialog.waitFor();
      await page.evaluate(() => (window as any).fixture.fail(true));
      await click(dialog.getByRole("button", { name: "Red", exact: true }));
      await page.getByText("Could not save the icon. Try again.", { exact: true }).waitFor();
      assert.equal(
        await dialog.getByRole("button", { name: "Purple", exact: true }).getAttribute("aria-pressed"),
        "true",
      );
      await page.evaluate(() => (window as any).fixture.fail(false));
      await dialog.getByLabel("Custom color", { exact: true }).fill("#336699");
      await click(dialog.getByRole("button", { name: "Apply", exact: true }));
      await page.locator('.conversation-appearance-trigger [data-color="#336699"]').waitFor();
      if (!testCase.touch) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
      }
      await click(dialog.getByRole("button", { name: "Restore default", exact: true }));
      await page.waitForFunction(() => !document.querySelector("[data-appearance-card] [data-icon]"));
      await click(dialog.getByRole("button", { name: "Done", exact: true }));
      await page.evaluate(() => (window as any).fixture.setSidebar(true));
      if (testCase.width < 600) await click(page.getByRole("button", { name: "Show sidebar", exact: true }));
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${output}/${testCase.width}-${testCase.theme}-sidebar.png` });
      await writeFile(
        `${output}/${testCase.width}-${testCase.theme}-sidebar.txt`,
        await page.locator("body").innerText(),
      );
      const rowMenu = page.getByRole("button", { name: "Actions for Investment", exact: true });
      await click(rowMenu);
      await click(page.getByRole("menuitem", { name: "Change icon", exact: true }));
      await dialog.waitFor();
      await click(dialog.getByRole("button", { name: "Book", exact: true }));
      await page.locator('[data-thread-id="investment"] [data-icon="book"]').waitFor({ state: "attached" });
      assert.equal(
        await page.locator('[data-thread-id="investment"] .sidebar-activity-item__status.is-running').count(),
        1,
      );
      await click(dialog.getByRole("button", { name: "Done", exact: true }));
      await rowMenu.waitFor();
      // A write may finish after navigation, but must remain bound to its original conversation.
      await page.keyboard.press("Escape");
      await page.evaluate(() => (window as any).fixture.setSidebar(false));
      await click(page.getByRole("button", { name: "Change icon", exact: true }));
      await page.evaluate(() => (window as any).fixture.hold());
      await click(dialog.getByRole("button", { name: "Green", exact: true }));
      await page.evaluate(() => (window as any).fixture.setRoute("writing"));
      await dialog.waitFor({ state: "detached" });
      await page.evaluate(() => (window as any).fixture.release());
      await page.locator('.conversation-appearance-trigger [data-icon="chat"][data-color="default"]').waitFor();
      assert.equal(await page.locator("[data-appearance-card] [data-icon]").count(), 0);
      assert.deepEqual(errors, []);
      evidence.push({ ...testCase, box, errors });
      await context.close();
    }
  const zhContext = await browser.newContext({
    viewport: { width: 390, height: 850 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const zh = await zhContext.newPage();
  await zh.addInitScript("window.__name = target => target");
  await zh.goto(vite.resolvedUrls!.local[0] + "?locale=zh-CN");
  await zh.getByRole("textbox", { name: "Draft" }).waitFor({ timeout: 90000 });
  await zh.evaluate(() => (window as any).fixture.setSidebar(false));
  await zh.getByRole("button", { name: "更改图标", exact: true }).tap();
  const zhDialog = zh.getByRole("dialog", { name: "会话图标" });
  await zhDialog.getByRole("button", { name: "紫色", exact: true }).tap();
  await zh.locator('.conversation-appearance-trigger [data-color="purple"]').waitFor();
  await zhDialog.getByRole("button", { name: "图表", exact: true }).tap();
  await zh.locator('.conversation-appearance-trigger [data-icon="chart"]').waitFor();
  const colorBox = await zhDialog.locator(".ui-color-input").boundingBox();
  assert.ok(colorBox && colorBox.width >= 44 && colorBox.height >= 44);
  await zh.screenshot({ path: `${output}/390-zh-CN.png` });
  await zh.emulateMedia({ forcedColors: "active" });
  await zh.keyboard.press("Tab");
  assert.equal(await zhDialog.evaluate((el) => el.contains(document.activeElement)), true);
  await zh.keyboard.press("Escape");
  assert.equal(await zh.getByRole("textbox", { name: "Draft" }).inputValue(), "Keep my draft");
  await zhContext.close();
  evidence.push({ locale: "zh-CN", width: 390, touch: true, reducedMotion: true, forcedColors: true });
  await writeFile(
    `${output}/results${process.env.OPENCRAFT_SMOKE_LOCALE_ONLY === "1" ? "-locale" : ""}.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify({ passed: evidence.length, output }));
} finally {
  await browser?.close();
  await vite.close();
}
