import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/sidebar-row-geometry");
const source = `
import React,{useEffect} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarNavigationItem} from '/apps/workbench-web/src/components/sidebar-navigation-item.tsx';
import {NavigationList} from '@opencraft/design-system-web/navigation';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {FolderIcon,AgentIcon} from '@opencraft/design-system-web/action-icons';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const store=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
let calls=0;
function Fixture(){const preferences=useUiPreferencesRuntime();
useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);
window.fixture={density:v=>preferences.set('interface.touchFriendly',v ? 'on' : 'off'),theme:setThemePreference,calls:()=>calls};
return <div className="shell-sidebar__column" style={{width:280,height:600}}>
<Sidebar threads={[]} activeHostId="local" activeThreadId="" sidebarLayout={store}
 onSelectThread={()=>{}} onNewTask={()=>calls++} onOpenSettings={()=>{}}
 showStart={false} showFooter={false} showNewChat searchInDialog
 catalogs={[{id:'destinations',title:'Destinations',presentation:'entry',content:
 <NavigationList inset="contained" label="Destinations">
 <SidebarNavigationItem title="Inbox" icon={<FolderIcon/>} onInvoke={()=>{}}/>
 <SidebarNavigationItem title="Assistants" icon={<AgentIcon/>} onInvoke={()=>{}}/>
 </NavigationList>}]} /></div>}
createIntlTestRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: "error",
  publicDir: "apps/workbench-web/public",
  cacheDir: "node_modules/.vite-sidebar-row-geometry",
  esbuild: { jsx: "automatic", target: "esnext" },
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-intl",
      "@tanstack/react-query",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
    ],
  },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "sidebar-row-geometry",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.headers.accept?.includes("text/html")) return next();
          response.setHeader("content-type", "text/html");
          response.end('<div id="root"></div><script type="module" src="/fixture.tsx"></script>');
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.getByRole("button", { name: "Inbox", exact: true }).waitFor();
  const evidence = [];
  const measure = () =>
    page.evaluate(() =>
      ["Inbox", "Assistants", "New chat"].map((label) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (row) => row.getAttribute("aria-label") === label || row.textContent === label,
        )!;
        const row = button.getBoundingClientRect(),
          icon = button.querySelector("svg")!.getBoundingClientRect();
        const text = button.querySelector("[data-navigation-label]")!.getBoundingClientRect();
        return { label, iconX: icon.x - row.x, labelX: text.x - row.x, width: icon.width, height: row.height };
      }),
    );
  for (const touch of [false, true])
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        async ({ touch, theme }) => {
          await (window as any).fixture.density(touch);
          (window as any).fixture.theme(theme);
        },
        { touch, theme },
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const rows = await measure();
      for (const row of rows) {
        assert.equal(row.iconX, rows[0].iconX, JSON.stringify(rows));
        assert.equal(row.labelX, rows[0].labelX, JSON.stringify(rows));
        assert.equal(row.width, rows[0].width);
        assert.ok(row.height >= (touch ? 44 : 32));
      }
      await page.screenshot({ path: resolve(output, `${touch ? "touch" : "mouse"}-${theme}.png`) });
      evidence.push({ touch, theme, rows });
    }
  // Prove the measurement rejects the original margin regression.
  const negative = await page.addStyleTag({ content: ".sidebar-new-chat > svg { margin-inline: 7px !important; }" });
  assert.notEqual((await measure())[2].iconX, (await measure())[0].iconX);
  await negative.evaluate((element) => element.remove());
  await page.getByRole("button", { name: "New chat", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => (window as any).fixture.calls()), 1);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "measurements.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: 4, output }));
} finally {
  await browser?.close();
  await server.close();
}
