import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";
const output = resolve(".local/presentation-lifecycle");
await mkdir(output, { recursive: true });
const original = await readFile("scripts/smoke/shell/smoke-panel-toolbar-ownership.ts", "utf8");
let source = original.split("const source=`")[1]!.split("`;")[0]!;
source =
  `import {AnimatePresence} from 'motion/react';
import ConversationInformationDialog from '/apps/workbench-web/src/components/conversation-information-dialog.tsx';
import {usePresentationCompletion} from '/apps/workbench-web/src/components/use-presentation-completion.ts';
import {FloatingComposerState} from '/apps/workbench-web/src/components/floating-composer-state.ts';
import {useRef,useCallback} from 'react';\n` + source;
source = source.replace("for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});", "");
source = source.replace("</AppShell>", "<LifecycleFixture/></AppShell>");
source += `
const composer=new FloatingComposerState();
function LifecycleFixture(){const [open,setOpen]=useState(false);const snapshot=useSyncExternalStore(composer.subscribe,composer.getSnapshot);const ref=useRef(null);const done=useCallback(()=>composer.completePresentation(snapshot),[snapshot]);
usePresentationCompletion(ref,snapshot.phase==='entering'||snapshot.phase==='exiting',snapshot,done);
window.lifecycle={setOpen,composer};
return <><button id='open-info' onClick={()=>setOpen(true)}>Info</button><AnimatePresence>{open&&<ConversationInformationDialog key='info' project='Motion lifecycle' workspaceDirectory='/workspace' onDismiss={()=>setOpen(false)} returnFocus={()=>document.getElementById('open-info')}/>}</AnimatePresence>
<div ref={ref} data-composer-phase={snapshot.phase} style={{opacity:snapshot.phase==='exiting'||snapshot.phase==='hidden'?0:1,transition:'opacity 500ms linear'}}>Composer presentation clock</div></>}
`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: ".local/.vite-lifecycle",
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "lifecycle",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  await writeFile(
    output + "/app.cjs",
    `const{app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(()=>new BrowserWindow({show:true,width:390,height:844}).loadURL('about:blank'));`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  browser = await _electron.launch({
    executablePath: "/opt/opencraft/runtime/browser/electron/electron",
    args: [
      "--ozone-platform=headless",
      "--ozone-override-screen-size=1600,1200",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      output + "/app.cjs",
    ],
    env,
  });
  const page = await browser.firstWindow();
  page.on("pageerror", (e) => console.error(e));
  await page.addInitScript("window.__name=value=>value");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(vite.resolvedUrls!.local[0]!);
  await page.waitForFunction(() => !!(window as any).lifecycle);
  await page.locator("#open-info").click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: output + "/sheet-open.png" });
  await page.evaluate(() => (window as any).lifecycle.setOpen(false));
  await page.waitForFunction(() => !!document.querySelector(".modal-surface[data-state=closed]"));
  await page.evaluate(() => {
    for (const a of document.querySelector(".modal-surface")!.getAnimations()) {
      a.pause();
      a.currentTime = 60;
    }
  });
  await page.screenshot({ path: output + "/sheet-exit.png" });
  await page.evaluate(() => (window as any).lifecycle.setOpen(true));
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole("dialog").count(), 1, "reopening revokes old removal");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => (window as any).lifecycle.composer.hide("a"));
  await page.waitForTimeout(180);
  assert.equal(
    await page.locator("[data-composer-phase]").getAttribute("data-composer-phase"),
    "exiting",
    "actual animation outlives old 120ms timer",
  );
  await page.evaluate(() => (window as any).lifecycle.composer.show("a"));
  await page.waitForFunction(() => document.querySelector("[data-composer-phase=visible]"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#open-info").click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.locator("#open-info").click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(250);
  const handle = await page.locator(".modal-surface__sheet-handle").boundingBox();
  assert.ok(handle);
  const x = handle.x + handle.width / 2,
    y = handle.y + handle.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 90 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("#open-info").click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  console.log(
    "PASS touch drag, wide dialog, sheet exit, interruption/reopen, reduced motion, CSS-owned composer completion",
  );
} finally {
  await browser?.close();
  await vite.close();
}
