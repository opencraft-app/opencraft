import { verifyPreviewCompositionInBrowser } from "./overview-composition-contract";
import { execFileSync } from "node:child_process";
import { installOverviewPerformanceProbe } from "./overview-performance-probe";
import assert from "node:assert/strict";
import {
  startChromeCapture,
  finishChromeCapture,
  assertChromeFrames,
  assertChromeBoundaries,
} from "./overview-chrome-checks";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/tab-overview");
await mkdir(output, { recursive: true });
const presentation = process.env.OPENCRAFT_PRESENTATION_FIXTURE
  ? JSON.parse(await readFile(process.env.OPENCRAFT_PRESENTATION_FIXTURE, "utf8"))
  : null;
const original = await readFile("scripts/smoke/shell/smoke-panel-toolbar-ownership.ts", "utf8");
let source = original.split("const source=`")[1]!.split("`;")[0]!;
source = source.replace(
  "import React,{useState,useSyncExternalStore}",
  "import React,{useState,useEffect,useRef,useSyncExternalStore}",
);
source =
  "import {usePanelNavigation} from '/apps/workbench-web/src/components/panel-navigation';\nimport {PanelOverviewButton,usePanelOverviewPresentation} from '/apps/workbench-web/src/components/panel-overview-presentation.tsx';\nimport {useShellPresentation} from '/apps/workbench-web/src/components/shell-presentation.ts';\nimport {ComposerPanelToggle} from '/apps/workbench-web/src/components/composer-panel-toggle.tsx';\nimport { observeBorderBoxHeight } from '@opencraft/timeline-host-web';\nimport { Terminal } from '@xterm/xterm';\nimport '@xterm/xterm/css/xterm.css';\nimport * as themeEngine from '@opencraft/design-system/theme-engine';\n" +
  source;
source = source.replace(
  "for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});",
  `
const terminals=new Map();let terminalMounts=0;let chatMounts=0;let previewCalls=0;let frameLoads=0;
function TerminalFixture({tab,active,overviewPreview}){const ref=useRef(null);const [presented,setPresented]=useState(!!active);if((active||overviewPreview)&&!presented)setPresented(true);useEffect(()=>{if(!presented)return;terminalMounts++;const t=new Terminal({cols:80,rows:24,fontSize:14,theme:{background:'#191919',foreground:'#e5e5e5'}});t.open(ref.current);t.write('\\x1b[32m$ npm run build\\x1b[0m\\r\\n✓ build complete\\r\\n$ ');terminals.set(tab.id,t);return()=>{terminals.delete(tab.id);t.dispose()};},[presented]);return <div className='terminal-panel' data-native-terminal={tab.id} data-input-active={active} style={{background:'#191919'}}><div ref={ref} style={{width:'100%',height:'100%'}}/><div data-retained-preview-chrome><button>Terminal keyboard</button></div></div>}
function ChatFixture(){const scene=useShellPresentation();const overview=usePanelOverviewPresentation();useEffect(()=>{window.overview=overview},[overview]);useEffect(()=>{window.scene=scene},[scene]);useEffect(()=>{chatMounts++},[]);return <div data-real-chat style={{height:'100%',overflow:'auto',background:'var(--color-background-surface)'}}><input aria-label='Draft' defaultValue='Keep draft'/><span style={{position:'absolute',bottom:0,right:0}}><ComposerPanelToggle/></span>{scene?.contentPresentation==='split'?<span data-wide-primary style={{position:'absolute',top:0,right:0}}><PanelOverviewButton composer placement='toolbar'/></span>:null}<h2>Real chat layout</h2><p><strong>Markdown stays formatted</strong></p><pre>const answer = 42;</pre><iframe title='Stateful chat content' srcDoc='<script>window.marker=1</script><p>Live frame</p>' onLoad={()=>frameLoads++}/>{Array.from({length:24},(_,i)=><p key={i}>Message {i}: the original reading surface.</p>)}</div>}
function BrowserFixture({onPresentationReady}){const nav=usePanelNavigation();useEffect(()=>{window.browserNavigation=nav},[nav]);useEffect(()=>{if(window.holdBrowserPresentation)window.releaseBrowserPresentation=onPresentationReady;else onPresentationReady?.();},[onPresentationReady]);return <div data-browser-scene style={{width:'100%',height:'100%'}}>Browser scene<PanelOverviewButton/></div>}
const registrations=[{kind:'browser',Component:BrowserFixture,presentationReadiness:'renderer',preview:()=>{const canvas=document.createElement('canvas');canvas.width=390;canvas.height=800;const context=canvas.getContext('2d');context.fillStyle=window.previewColor||'#245c45';context.fillRect(0,0,390,800);context.fillStyle='white';context.font='24px sans-serif';context.fillText('Browser preview',24,50);return {kind:'image',src:canvas.toDataURL()}}},{kind:'terminal',Component:TerminalFixture,residency:'while-tab-open',previewPresentation:'retained-view',previewFallback:'reparent-safe',preview:()=>{previewCalls++;throw Error('a retained view must not request a second preview')}}];
for(const [kind,title,icon]of [['browser','OpenCraft 文档 — a very long browser title that stays on one line','browser'],['resource','项目文件','file'],['custom','扩展工具','apps']]){panels.register({kind,createTab:()=>({id:kind,kind,region:'right',title,icon,closable:true,preview:false})});}
panels.dispatch('scope',{type:'set-region-open',region:'right',open:true});panels.dispatch('scope',{type:'toggle-right-full-width'});`,
);
if (presentation)
  source = source.replace(
    "const registrations=[",
    `const registrations=[{kind:'browser',Component:()=>null,preview:()=>({kind:'image',src:${JSON.stringify(presentation.thumbnail)},iconSrc:${JSON.stringify(presentation.favicon)}})},`,
  );
source = source.replace(
  "window.fixture={panels,setThemePreference}",
  `window.fixture={panels,setThemePreference,measure:node=>{let result;const stop=observeBorderBoxHeight(node,h=>result=h);stop();return result},terminals,terminalMounts:()=>terminalMounts,chatMounts:()=>chatMounts,frameLoads:()=>frameLoads,previewCalls:()=>previewCalls,setPreview:text=>{for(const t of terminals.values())t.write('\\x1b[2J\\x1b[H'+text.replaceAll('\\n','\\r\\n'))},paletteTheme:(palette,mode)=>{document.documentElement.dataset.theme=mode;document.documentElement.style.colorScheme=mode;for(const [key,value]of Object.entries(themeEngine.buildOpenCraftThemeCssProperties(mode,themeEngine[palette][mode])))document.documentElement.style.setProperty(key,value)},customTheme:()=>{document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';for(const [key,value]of Object.entries(themeEngine.buildOpenCraftThemeCssProperties('light',themeEngine.lavenderThemePalette.light)))document.documentElement.style.setProperty(key,value)}}`,
);
source = source.replace(
  "<input aria-label='Draft' defaultValue='Keep draft'/></AppShell>",
  "<ChatFixture/></AppShell>",
);
source = source.replace(
  "toolbarActions={[action]}",
  `toolbarActions={[action,...['browser','resource','sidechat','custom','extra-one','extra-two'].map((kind,index)=>({id:kind,region:'right',icon:kind==='sidechat'?'chat':kind,label:['Web page','Files','Side chat','Extension','Another tool','Last tool'][index],creationLabel:kind,run:()=>panels.open('scope','terminal',{id:crypto.randomUUID()})}))]}`,
);
source = source.replace("renderers={[]}", `renderers={registrations}`);
// Exercise owner changes through the actual Shell, not a replacement mock.
source = source.replace(
  "function App(){const state=useSyncExternalStore(subscribe,get);",
  "function App(){const [ownerId,setOwnerId]=useState('scope');const state=useSyncExternalStore(f=>panels.subscribeOwner(ownerId,f),()=>panels.getOwnerSnapshot(ownerId));window.setFixtureOwner=setOwnerId;",
);
const appStart = source.indexOf("function App(){"),
  appEnd = source.indexOf("createRoot(", appStart);
source =
  source.slice(0, appStart) +
  source
    .slice(appStart, appEnd)
    .replaceAll("'scope'", "ownerId")
    .replace("useState(ownerId)", "useState('scope')")
    .replace("layoutScope='toolbar-ownership'", "layoutScope={ownerId}")
    .replace("sceneOwnerId=ownerId", "sceneOwnerId={ownerId}") +
  source.slice(appEnd);
if (process.env.OPENCRAFT_OVERVIEW_SIDECHAT_ONLY || process.env.OPENCRAFT_OVERVIEW_CADENCE_ONLY) {
  source = "import { installSideChatPreviewFixture } from '/tests/fixtures/side-chat-preview.tsx';\n" + source;
  source = source.replace("const registrations=[", "const registrations=[await installSideChatPreviewFixture(ctx),");
}
if (process.env.OPENCRAFT_OVERVIEW_CONFIRMATION_ONLY) {
  source =
    "import { FilePathRegression, SideChatCloseRegression } from '/tests/fixtures/mobile-file-sidechat.tsx';\n" +
    source;
  source = source.replace("<h2>Real chat layout</h2>", "<FilePathRegression/><h2>Real chat layout</h2>");
  source = source
    .replace("return <AppShell", "return <><AppShell")
    .replace("</AppShell>}", "</AppShell><SideChatCloseRegression/></>}");
  source = source.replace(
    "createRoot(document.getElementById('root'))",
    "createRoot(document.getElementById('root'),undefined,'" + (process.env.OPENCRAFT_TEST_LOCALE ?? "zh-CN") + "')",
  );
}
await writeFile(output + "/fixture.tsx", source);
// Replay the same fixture/probes against a fixed earlier source, without
// swapping the checkout under another process. Used as a performance control.
const baselineFiles = new Map<string, string>();
if (process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE)
  for (const file of [
    "app-shell.tsx",
    "overview-scene-motion.ts",
    "retained-preview-placement.ts",
    "retained-view-preview.tsx",
    "retained-view-preview.scss",
  ]) {
    const path = "apps/workbench-web/src/components/" + file;
    baselineFiles.set(
      resolve(path),
      execFileSync("git", ["show", process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE + ":" + path], { encoding: "utf8" }),
    );
  }
const vite = await createServer({
  configFile: false,
  mode: process.env.OPENCRAFT_SMOKE_PRODUCTION ? "production" : "development",
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: process.env.OPENCRAFT_SMOKE_CACHE ?? resolve(output, "vite-cache"),
  optimizeDeps: {
    entries: [resolve(output, "fixture.tsx")],
    include: [
      "react",
      "react/jsx-runtime",
      "react-dom",
      "react-dom/client",
      "react-intl",
      "@xterm/xterm",
      "@shikijs/langs/typescript",
    ],
  },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    { name: "review-baseline", enforce: "pre", load: (id) => baselineFiles.get(id.split("?")[0]!) },
    {
      name: "observe-scene-driver",
      enforce: "pre",
      transform(code, id) {
        if (process.env.OPENCRAFT_OVERVIEW_SCROLL_ONLY && id.endsWith("/retained-preview-placement.ts"))
          return code.replace(
            "const measure = () => {",
            "const measure = () => { if ((window as any).pausePreviewMeasurements) return;",
          );
        if (!id.endsWith("/overview-scene-motion.ts")) return;
        if (process.env.OPENCRAFT_OVERVIEW_CADENCE_BASELINE)
          code = code
            .replace(
              "import { animateOverviewProgress as animate } from './overview-playback';",
              "import { animateOverviewProgress as animate } from 'motion/react';",
            )
            .replace("animateOverviewProgress as animate", "animate as observedAnimate")
            .replace(
              "velocity: inheritedVelocity, onUpdate:",
              "startTime: performance.now(), velocity: inheritedVelocity, onUpdate:",
            );
        if (process.env.OPENCRAFT_OVERVIEW_RESPONSIVENESS_BASELINE || process.env.OPENCRAFT_OVERVIEW_HEADING_ONLY)
          code = code.replace(
            "if ((entering || returning) && geometry >=",
            "if (false && (entering || returning) && geometry >=",
          );
        return (
          code.replace("animateOverviewProgress as animate", "animateOverviewProgress as observedAnimate") +
          '\nfunction animate(...args:any[]){const w=window as any;w.sceneDriverHistory??=[];w.sceneDriverHistory.push({from:typeof args[0]==="number"?args[0]:args[0].get(),target:args[1],velocity:args[2]?.velocity??0});if(w.captureSceneCadence){const report={from:args[0].get(),target:args[1],updates:[]};w.cadenceDrivers.push(report);const update=args[2].onUpdate;args[2].onUpdate=(v:number)=>{let reads=0;const rect=Element.prototype.getBoundingClientRect,css=window.getComputedStyle;Element.prototype.getBoundingClientRect=function(){reads++;return rect.call(this)};window.getComputedStyle=(...a:any[])=>{reads++;return (css as any)(...a)};const at=performance.now();try{w.overviewPerformance.progress=v;w.overviewPerformance.run("update",()=>update(v))}finally{Element.prototype.getBoundingClientRect=rect;window.getComputedStyle=css;report.updates.push({value:v,at:performance.now(),duration:performance.now()-at,reads});}}}const playback=(observedAnimate as any)(...args);w.scenePlayback=playback;if(w.pauseNextScene){w.pauseNextScene=false;playback.pause();playback.time=w.headingReview?0:w.pauseSceneTime??.06;}return playback}'
        );
      },
    },
    {
      name: "overview-fixture",
      enforce: "pre",
      resolveId: (id, importer) =>
        id === "/overview-fixture.tsx"
          ? id
          : importer?.endsWith("/side-chat-panel-plugin.tsx") && id === "../runtime/appserver-runtime-context"
            ? "\0overview-thread-catalog"
            : null,
      load: (id) =>
        id === "/overview-fixture.tsx"
          ? source
          : id === "\0overview-thread-catalog"
            ? 'export function useThreadCatalog(){return {threads:[{id:"parent",title:"Parent conversation"}]}}'
            : null,
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/overview-fixture.tsx"></script>',
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
  if (process.env.OPENCRAFT_SMOKE_BROWSER === "chromium") {
    const { chromium } = await import("playwright");
    const chromiumBrowser = await chromium.launch({
      headless: true,
      executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    });
    const chromiumPage = await chromiumBrowser.newPage({ hasTouch: true });
    browser = { firstWindow: async () => chromiumPage, close: () => chromiumBrowser.close() };
  } else
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
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log("PAGE ERROR", e.message);
  });
  page.on("requestfailed", (r) => console.log("FAILED", r.url(), r.failure()));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text());
  });
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.addInitScript("window.__name=value=>value");
  await page.addInitScript(installOverviewPerformanceProbe);
  if (process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER || process.env.OPENCRAFT_PREVIEW_FORCE_LEGACY)
    await page.addInitScript("delete Element.prototype.moveBefore");
  if (process.env.OPENCRAFT_PREVIEW_FORCE_LEGACY)
    await page.addInitScript("delete HTMLElement.prototype.showPopover;delete HTMLElement.prototype.hidePopover");
  await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "commit" });
  try {
    await page.waitForFunction(() => !!(window as any).fixture, null, { timeout: 10000 });
  } catch (error) {
    if (errors.length) throw error;
    await page.reload();
    await page.waitForFunction(() => !!(window as any).fixture, null, { timeout: 120000 });
  }
  await page.evaluate(() => (document.documentElement.dataset.uiDensity = "touch"));
  await page.waitForFunction(() => !!(window as any).scene);
  await page.evaluate(() => (window as any).scene.selectTools());
  if (
    !process.env.OPENCRAFT_OVERVIEW_RESPONSIVENESS_ONLY &&
    !process.env.OPENCRAFT_OVERVIEW_MOTION_ONLY &&
    !process.env.OPENCRAFT_OVERVIEW_HEADING_ONLY &&
    !process.env.OPENCRAFT_OVERVIEW_SCRIM_ONLY &&
    !process.env.OPENCRAFT_PREVIEW_FORCE_LEGACY
  )
    await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate((headingReview) => {
    (window as any).headingReview = headingReview;
    (window as any).readHeading = (frame: HTMLElement) => {
      const heading = frame.querySelector<HTMLElement>(".panel-overview-card__heading")!;
      const rect = heading.getBoundingClientRect();
      const ink = [...heading.querySelectorAll("svg,img")].map((n) => n.getBoundingClientRect());
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          ink.push(...range.getClientRects());
        }
      const boxes = ink.filter((r) => r.width > 0 && r.height > 0);
      const content = frame.querySelector("[data-overview-view]")!.getBoundingClientRect();
      return {
        opacity: Number(getComputedStyle(heading).opacity),
        rect: rect.toJSON(),
        inkTop: Math.min(...boxes.map((r) => r.top)),
        inkBottom: Math.max(...boxes.map((r) => r.bottom)),
        frame: frame.getBoundingClientRect().toJSON(),
        content: content.toJSON(),
      };
    };
  }, !!process.env.OPENCRAFT_OVERVIEW_HEADING_ONLY);
  if (process.env.OPENCRAFT_OVERVIEW_CADENCE_ONLY) {
    await assertChromeBoundaries(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.waitForFunction(() => !(window as any).overview.open);
    const draft = await page.locator("[data-real-chat] input").elementHandle();
    await page.locator("[data-real-chat] input").fill("Cadence preserves identity");
    await page.evaluate(() => {
      const w = window as any;
      w.fixture.panels.open("scope", "terminal", { id: "cadence-terminal" });
      w.fixture.panels.open("scope", "sidechat", {
        id: "sidechat:side-preview",
        resource: "side-preview",
        title: "Side chat",
        pending: false,
      });
      w.scene.selectPrimary();
    });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => ({
      frames: (window as any).fixture.frameLoads(),
      side: (window as any).sidePreview.inspect(),
    }));
    // Select the physically reachable control: parked retained roots can have a
    // CSS-visible Composer outside the viewport. Do not force-click that old scene.
    const openOverview = async () => {
      const point = await (
        await page.waitForFunction(() => {
          for (const button of document.querySelectorAll<HTMLElement>(
            '[data-testid="composer-panel-toggle"], .panel-mobile-dock__tabs',
          )) {
            const r = button.getBoundingClientRect(),
              x = r.x + r.width / 2,
              y = r.y + r.height / 2;
            if (
              r.width &&
              r.height &&
              x > 0 &&
              y > 0 &&
              x < innerWidth &&
              y < innerHeight &&
              button.contains(document.elementFromPoint(x, y))
            )
              return { x, y };
          }
          return null;
        })
      ).jsonValue();
      assert(point, "current scene must expose a reachable overview action");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    if (!process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE) {
      await openOverview();
      await page.waitForTimeout(150);
      await writeFile(
        output + "/composition.json",
        JSON.stringify(await page.evaluate(verifyPreviewCompositionInBrowser), null, 2),
      );
      await page.locator(".panel-overview-primary .ui-object-title-button").click();
      await page.waitForFunction(() => !(window as any).overview.open);
    }
    if (process.env.OPENCRAFT_OVERVIEW_PROFILE) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const reports = [];
    for (const kind of ["primary", "terminal", "sidechat"]) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (kind !== "primary") {
        await openOverview();
        await page.locator('.panel-overview-card[data-tab-kind="' + kind + '"] .ui-object-title-button').click();
        await page.waitForFunction(() => !(window as any).overview.open);
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const rate of [1, 6]) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        for (const direction of ["shrink", "expand"]) {
          await page.evaluate(() => {
            const w = window as any;
            w.captureSceneCadence = true;
            w.cadenceDrivers = [];
            w.cadenceGeometry = [];
            w.cadenceFrames = [];
            w.overviewPerformance.records = [];
            w.overviewPerformance.progress = undefined;
            const sample = () => {
              w.cadenceFrames.push(performance.now());
              const frame = document.querySelector("[data-overview-flight]");
              if (frame) {
                const rect = frame.getBoundingClientRect();
                w.cadenceGeometry.push({ width: rect.width, height: rect.height, at: performance.now() });
              }
              w.cadenceFrame = requestAnimationFrame(sample);
            };
            w.cadenceFrame = requestAnimationFrame(sample);
          });
          await startChromeCapture(page);
          if (direction === "shrink") {
            await openOverview();
            await page.waitForFunction(
              () => !!(window as any).overview.open && !document.querySelector("[data-overview-phase]"),
            );
          } else {
            await page
              .locator(
                (kind === "primary"
                  ? ".panel-overview-primary"
                  : '.panel-overview-card[data-tab-kind="' + kind + '"]') + " .ui-object-title-button",
              )
              .click();
            await page.waitForFunction(
              () => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1,
            );
          }
          // Include the post-handback tail: the obsolete CSS clock used to restart here.
          await page.waitForTimeout(350);
          const chromeFrames = await finishChromeCapture(page);
          await writeFile(
            output + "/chrome-" + kind + "-" + rate + "-" + direction + ".json",
            JSON.stringify(chromeFrames, null, 2),
          );
          if (!process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE)
            assertChromeFrames(chromeFrames, kind + " " + rate + " " + direction);
          // Include the handback/unmount and the following observer delivery, even
          // after there is no longer a [data-overview-flight] element to sample.
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
          const drivers = await page.evaluate(() => {
            const w = window as any;
            w.captureSceneCadence = false;
            cancelAnimationFrame(w.cadenceFrame);
            w.cadenceDrivers[0].geometry = w.cadenceGeometry;
            w.cadenceDrivers[0].frames = w.cadenceFrames;
            w.cadenceDrivers[0].performance = w.overviewPerformance.records;
            return w.cadenceDrivers;
          });
          assert.equal(drivers.length, 1, kind + " " + direction);
          const driver = drivers[0];
          assert.equal(
            driver.updates[0].value,
            driver.from,
            "allocation work must not consume the first presentation frame",
          );
          assert(
            new Set(driver.geometry.map((g: any) => Math.round(g.width))).size >= 4,
            "actual flight geometry must span intermediate animation frames",
          );
          const middle = driver.updates.filter((u: any) => u.value > 0.07 && u.value < 0.98);
          assert(middle.length >= 4, JSON.stringify({ kind, rate, direction, driver }));
          assert(
            middle.every((u: any) => u.reads === 0),
            "flight projection must not read layout after writing: " +
              JSON.stringify({ kind, rate, direction, middle }),
          );
          // Covers the asynchronous observers and final unmount, not only the
          // geometric middle of the spring. Budget includes the restoration
          // microtask: moving work out of onUpdate must not hide it.
          const handback = direction === "expand" ? driver.updates.find((u: any) => u.value <= 0.06) : null;
          const restoreCost = driver.performance
            .filter((r: any) => r.kind === "microtask:flushRetainedScroll")
            .reduce((n: number, r: any) => n + r.duration, 0);
          const forcedDocumentWidths = driver.performance.reduce(
            (n: number, r: any) => n + (r.forcedDocumentWidths ?? 0),
            0,
          );
          const frameGaps = driver.frames.slice(1).map((at: number, index: number) => at - driver.frames[index]);
          driver.metrics = {
            handoffMs: (handback?.duration ?? 0) + restoreCost,
            maxFrameGapMs: Math.max(0, ...frameGaps),
            forcedDocumentWidths,
          };
          if (!process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE && direction === "expand") {
            assert(handback, "handoff itself must be observed");
            assert.equal(
              forcedDocumentWidths,
              0,
              "handback must not restart CSS animation via whole-document forced layout",
            );
            const observers = driver.performance.filter(
              (r: any) => r.kind === "mutation:observePreviewComposition" && r.progress > 0.07 && r.progress < 0.98,
            );
            assert(
              observers.every((r: any) => r.reads === 0),
              "opacity-only observer work cannot remeasure siblings",
            );
            // Production-mode fixture budget, deliberately not a device FPS claim.
            if (process.env.OPENCRAFT_SMOKE_PRODUCTION) {
              assert(
                driver.metrics.handoffMs < 150 * rate,
                "handoff+restoration exceeded the controlled fixture budget: " +
                  JSON.stringify({ kind, rate, metrics: driver.metrics }),
              );
              assert(
                driver.metrics.maxFrameGapMs < 175 * rate,
                "complete-frame gap exceeded the controlled fixture budget: " +
                  JSON.stringify({ kind, rate, metrics: driver.metrics }),
              );
            }
          }
          reports.push({ kind, rate, direction, ...driver });
          await writeFile(output + "/cadence.json", JSON.stringify(reports, null, 2));
        }
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    // A side-chat destination also obeys reduced motion and an immediate reverse.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await startChromeCapture(page);
    await openOverview();
    await page.locator('.panel-overview-card[data-tab-kind="sidechat"] .ui-object-title-button').click();
    await page.waitForFunction(
      () => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1,
    );
    await page.waitForTimeout(350);
    const reducedChrome = await finishChromeCapture(page);
    if (!process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE) assertChromeFrames(reducedChrome, "sidechat reduced motion");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await startChromeCapture(page);
    // Pause before the first flight finishes, then invoke the real Done action.
    await page.evaluate(() => ((window as any).pauseNextScene = true));
    await openOverview();
    await page.waitForFunction(() => !!document.querySelector('[data-overview-phase="entering"]'));
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForFunction(
      () => !(window as any).overview.open && (window as any).overview.chromeOpacity.get() === 1,
    );
    await page.waitForTimeout(350);
    const reversedChrome = await finishChromeCapture(page);
    if (!process.env.OPENCRAFT_OVERVIEW_REVIEW_BASELINE)
      assertChromeFrames(reversedChrome, "sidechat interrupted shrink");
    await writeFile(output + "/chrome-interruptions.json", JSON.stringify({ reducedChrome, reversedChrome }, null, 2));
    await page.screenshot({ path: output + "/sidechat-settled.png" });
    if (process.env.OPENCRAFT_OVERVIEW_PROFILE) {
      const profile = await cdp.send("Profiler.stop");
      await writeFile(output + "/profile.json", JSON.stringify(profile.profile));
    }
    assert.equal(await draft!.evaluate((node) => node.isConnected), true);
    assert.equal(await page.locator("[data-real-chat] input").inputValue(), "Cadence preserves identity");
    const after = await page.evaluate(() => ({
      frames: (window as any).fixture.frameLoads(),
      side: (window as any).sidePreview.inspect(),
    }));
    assert.equal(after.frames, before.frames);
    assert.deepEqual(after.side, before.side);
    await writeFile(output + "/cadence.json", JSON.stringify(reports, null, 2));
    console.log(
      JSON.stringify(
        reports.map(({ kind, rate, direction, updates }) => ({
          kind,
          rate,
          direction,
          updates: updates.length,
          first: updates[0].value,
          middle: updates.filter((u: any) => u.value > 0.07 && u.value < 0.98).length,
        })),
      ),
    );
    assert.deepEqual(errors, []);
  } else if (process.env.OPENCRAFT_OVERVIEW_SUBSCRIPTIONS_ONLY) {
    // A global nonzero duration creates transitions on static elements, including
    // SVG backdrop references, and used to crash the native style resolver.
    const reducedTransition = await page.evaluate(() => {
      const node = document.createElement("div");
      node.style.opacity = "0";
      document.body.append(node);
      const before = getComputedStyle(node).opacity;
      node.style.opacity = "1";
      const style = getComputedStyle(node);
      const result = {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        duration: style.transitionDuration,
        delay: style.transitionDelay,
        transitions: node.getAnimations().filter((a) => a instanceof CSSTransition).length,
      };
      node.remove();
      return result;
    });
    if (reducedTransition.reduced) {
      assert.equal(reducedTransition.duration, "0s");
      assert.equal(reducedTransition.delay, "0s");
      assert.equal(reducedTransition.transitions, 0, "reduced motion must not invent a transition");
    }
    const readCount = () => page.locator('[data-testid="composer-panel-toggle"]:visible svg text').textContent();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        const w = window as any;
        w.fixture.setThemePreference(theme);
        w.scene.selectPrimary();
      }, theme);
      for (const touch of [true, false]) {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
        await page.evaluate(() => {
          const w = window as any;
          w.fixture.panels.open("scope", "terminal", { id: "subscription" }, { activate: false });
          w.scene.selectPrimary();
        });
        await page.waitForFunction(
          () => document.querySelector('[data-testid="composer-panel-toggle"] svg text')?.textContent === "1",
        );
        assert.equal(await readCount(), "1");
        assert.equal(await page.getByRole("dialog").count(), 0, "count is live without opening the overview modal");
        await page.evaluate(() => (window as any).setFixtureOwner("scope-other"));
        await page.waitForFunction(
          () => document.querySelector('[data-testid="composer-panel-toggle"] svg text')?.textContent === "0",
        );
        await page.evaluate(() => (window as any).setFixtureOwner("scope"));
        await page.waitForFunction(
          () => document.querySelector('[data-testid="composer-panel-toggle"] svg text')?.textContent === "1",
        );
        await page.evaluate(() => (window as any).fixture.panels.close("scope", "right", "subscription"));
        await page.waitForFunction(
          () => document.querySelector('[data-testid="composer-panel-toggle"] svg text')?.textContent === "0",
        );
      }
      await page.screenshot({ path: output + "/subscription-" + theme + ".png" });
    }
    assert.deepEqual(errors, []);
    await writeFile(
      output + "/subscription-verification.json",
      JSON.stringify(
        {
          passed: true,
          themes: ["light", "dark"],
          input: ["touch", "mouse"],
          checks: ["live count with overview closed", "owner switch isolation", "explicit close"],
        },
        null,
        2,
      ),
    );
    console.log("Panel count subscription checks passed");
    process.exitCode = 0;
  } else if (process.env.OPENCRAFT_OVERVIEW_SCROLL_ONLY) {
    await page.evaluate(() => {
      const w = window as any;
      for (let i = 0; i < 5; i++) w.fixture.panels.open("scope", "terminal", { id: String(i) });
      w.scene.selectPrimary();
    });
    await page.locator('[data-testid="composer-panel-toggle"]').click();
    await page.locator(".panel-overview-card").first().waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-retained-preview-positioning="anchor"]').length >= 2,
    );
    assert.equal(await page.locator(".panel-overview__count").count(), 0);
    const before = await page.evaluate(() => (window as any).fixture.frameLoads());
    const reports = [];
    // Hold main-thread projection still: native positioning must follow scrolling anyway.
    await page.evaluate((baseline) => {
      const w = window as any;
      w.pausePreviewMeasurements = true;
      for (const view of document.querySelectorAll<HTMLElement>('[data-retained-preview-positioning="anchor"]')) {
        view.dataset.testAnchor = view.style.left.match(/anchor\((--[^ ]+)/)?.[1];
        if (baseline) {
          const box = view.getBoundingClientRect();
          view.style.left = box.left + "px";
          view.style.top = box.top + "px";
          view.style.setProperty("position-anchor", "auto");
        }
      }
    }, !!process.env.OPENCRAFT_OVERVIEW_SCROLL_BASELINE);
    for (const top of [0, 40, 100, 230, 0]) {
      await page.locator(".panel-overview__scroll").evaluate((el, value) => (el.scrollTop = value), top);
      await page.waitForTimeout(100);
      const report = await page.evaluate(() => {
        const scroll = document.querySelector(".panel-overview__scroll")!.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>('[data-retained-preview-positioning="anchor"]')].map(
          (view) => {
            const name = view.dataset.testAnchor;
            const target = [...document.querySelectorAll<HTMLElement>("[style]")].find((e) =>
              e.style
                .getPropertyValue("anchor-name")
                .split(",")
                .map((s) => s.trim())
                .includes(name ?? ""),
            );
            const box = view.getBoundingClientRect(),
              expected = target!.getBoundingClientRect();
            return {
              kind: view.dataset.retainedView,
              box: box.toJSON(),
              expected: expected.toJSON(),
              scroll: scroll.toJSON(),
            };
          },
        );
      });
      for (const r of report) {
        if (r.expected.bottom <= r.scroll.top || r.expected.top >= r.scroll.bottom) continue;
        assert.ok(
          Math.min(Math.abs(r.box.top - r.expected.top), Math.abs(r.box.bottom - r.expected.bottom)) < 1,
          JSON.stringify(r),
        );
        assert.ok(Math.abs(r.box.left - r.expected.left) < 1, JSON.stringify(r));
      }
      reports.push({ top, views: report });
      await page.screenshot({ path: output + "/scroll-" + top + ".png" });
    }
    assert.equal(
      await page.evaluate(() => (window as any).fixture.frameLoads()),
      before,
      "scroll does not reload chat iframe",
    );
    await page.evaluate(() => ((window as any).pausePreviewMeasurements = false));
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("[data-retained-preview-positioning]"));
    assert.equal(await page.evaluate(() => (window as any).fixture.frameLoads()), before, "handback preserves iframe");
    await writeFile(output + "/scroll-report.json", JSON.stringify(reports, null, 2));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, anchoredScroll: true, iframeRetained: true, noCountBar: true }));
  } else if (process.env.OPENCRAFT_OVERVIEW_RESPONSIVENESS_ONLY) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.waitForFunction(() => !(window as any).overview.open);
    const owner = await page.locator("[data-real-chat]").elementHandle();
    await page.locator("[data-real-chat] input").fill("Keep responsive draft");
    await page.evaluate(() => {
      (window as any).fixture.panels.open("scope", "terminal", { id: "0" });
      (window as any).scene.selectPrimary();
    });
    const results = [];
    for (const kind of ["primary", "terminal"]) {
      if (kind === "terminal") {
        await page.locator('[data-testid="composer-panel-toggle"]').click();
        await page.locator('.panel-overview-card[data-tab-id="0"] .ui-object-title-button').click();
        await page.waitForFunction(() => !(window as any).overview.open);
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => {
        (window as any).pauseNextScene = true;
      });
      await page
        .locator(kind === "primary" ? '[data-testid="composer-panel-toggle"]' : ".panel-mobile-dock__tabs")
        .click();
      await page.waitForFunction(() => !!document.querySelector("[data-overview-flight]"));
      const result = await page.evaluate(async () => {
        const w = window as any;
        const duration = w.scenePlayback.duration;
        w.scenePlayback.time = 0.4;
        await new Promise(requestAnimationFrame);
        const frame = document.querySelector<HTMLElement>("[data-overview-flight]");
        const slot = document.querySelector<HTMLElement>("[data-overview-flight-slot]");
        const a = frame?.getBoundingClientRect(),
          b = slot?.getBoundingClientRect();
        return {
          duration,
          locked: !!frame,
          phase: document.querySelector("[data-overview-phase]")?.getAttribute("data-overview-phase"),
          edgeError:
            a && b
              ? Math.max(Math.abs(a.left - b.left), Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom))
              : 0,
        };
      });
      results.push({ kind, ...result });
      if (process.env.OPENCRAFT_OVERVIEW_RESPONSIVENESS_BASELINE) {
        assert(result.locked && result.edgeError < 0.5, JSON.stringify(result));
        console.log(JSON.stringify({ baseline: true, results }));
        break;
      }
      assert.equal(
        result.locked,
        false,
        "visually settled card must stop blocking hit testing: " + JSON.stringify(result),
      );
      assert.equal(result.phase, undefined);
      const mounts = await page.evaluate(() => (window as any).fixture.terminalMounts());
      const card = page.locator(
        kind === "primary" ? ".panel-overview-primary" : '.panel-overview-card[data-tab-id="0"]',
      );
      const button = card.locator(".ui-object-title-button");
      const box = await button.boundingBox();
      assert(box);
      // Raw native contact has no locator auto-wait to conceal a blocked interval.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => !(window as any).overview.open);
      assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), mounts);
      assert(await page.locator("[data-real-chat]").evaluate((node, old) => node === old, owner));
      assert.equal(await page.locator("[data-real-chat] input").inputValue(), "Keep responsive draft");
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: output + "/responsive.png" });
    console.log(JSON.stringify({ ok: true, results }));
  } else if (process.env.OPENCRAFT_OVERVIEW_SIDECHAT_ONLY) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() =>
      (window as any).fixture.panels.open("scope", "sidechat", {
        id: "sidechat:side-preview",
        resource: "side-preview",
        title: "Side chat",
        pending: false,
      }),
    );
    const side = page.locator(".side-chat-panel");
    await side.waitFor();
    await side.locator("strong").filter({ hasText: "Side answer 4" }).waitFor();
    await side.evaluate((node) => {
      (window as any).originalSide = node;
    });
    const codeStyle = await side
      .locator("pre")
      .first()
      .evaluate((n) => {
        const s = getComputedStyle(n);
        return { font: s.font, padding: s.padding, whiteSpace: s.whiteSpace };
      });
    await side
      .locator("[data-thread-scroll-viewport]")
      .evaluate((n) => {
        n.scrollTop = n.scrollHeight;
      })
      .catch(() => {});
    await side.locator('[data-testid="composer-panel-toggle"]').click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const card = page.locator('.panel-overview-card[data-tab-kind="sidechat"]');
    const native = await page.evaluate(
      () =>
        typeof HTMLElement.prototype.showPopover === "function" ||
        typeof (Element.prototype as any).moveBefore === "function",
    );
    if (native) {
      await page.waitForFunction(
        () => !!document.querySelector(".side-chat-panel")?.closest('[data-retained-preview="true"]'),
      );
      const observed = await side.evaluate((node) => ({
        same: node === (window as any).originalSide,
        inert: !!node.closest("[inert]"),
        footer: getComputedStyle(node.querySelector(".thread-scroll-footer")!).visibility,
        formatted: !!node.querySelector("strong"),
        code: !!node.querySelector("pre"),
        focus: node.contains(document.activeElement),
      }));
      assert.ok(
        observed.same && observed.inert && observed.formatted && observed.code && !observed.focus,
        JSON.stringify(observed),
      );
      assert.equal(observed.footer, "hidden");
      assert.equal(
        await card.locator(".panel-overview-primary__messages").count(),
        0,
        "no reconstructed conversation bubbles",
      );
      assert.deepEqual(
        await side
          .locator("pre")
          .first()
          .evaluate((n) => {
            const s = getComputedStyle(n);
            return { font: s.font, padding: s.padding, whiteSpace: s.whiteSpace };
          }),
        codeStyle,
        "original code formatting survives preview placement",
      );
      const reads = await page.evaluate(() => (window as any).sidePreview.inspect().historyReads);
      await page.evaluate(() => (window as any).sidePreview.append());
      await side.locator("strong").filter({ hasText: "Side answer 5" }).waitFor();
      await page.screenshot({ path: output + "/sidechat-live.png" });
      assert.equal(
        await page.evaluate(() => (window as any).sidePreview.inspect().historyReads),
        reads,
        "thumbnail does not load history",
      );
    } else {
      assert.equal(await card.getByText("Return to the conversation").count(), 1);
    }
    await card.locator(".ui-object-title-button").click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(await side.evaluate((n) => n === (window as any).originalSide), true);
    assert.equal(
      await side.locator(".thread-scroll-footer").evaluate((n) => getComputedStyle(n).visibility),
      "visible",
    );
    assert.ok(
      await page.evaluate(
        () =>
          !document
            .querySelector(".side-chat-panel")!
            .contains(document.activeElement?.closest("input,textarea,[contenteditable=true],[role=textbox]") ?? null),
      ),
      "overview return does not summon the editor",
    );
    const state = await page.evaluate(() => (window as any).sidePreview.inspect());
    assert.equal(state.mounts, 1);
    assert.equal(state.unmounts, 0);
    assert.equal(state.submits, 0);
    assert.equal(state.draft, "Keep side draft");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, sidechat: true, native, state, output }));
  } else if (process.env.OPENCRAFT_OVERVIEW_CONFIRMATION_ONLY) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (process.env.OPENCRAFT_TEST_WIDTH) {
      const width = Number(process.env.OPENCRAFT_TEST_WIDTH);
      await page.setViewportSize({ width, height: 844 });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    }
    await page.evaluate(() => (window as any).scene.selectPrimary());
    await page.locator(".workspace-file-path").waitFor();
    await page.locator("[data-real-chat]").evaluate(async (node) => {
      let previous = "",
        stable = 0;
      for (let i = 0; i < 120 && stable < 4; i++) {
        await new Promise(requestAnimationFrame);
        const rect = node.getBoundingClientRect(),
          next = [rect.x, rect.width].join(",");
        stable = next === previous ? stable + 1 : 0;
        previous = next;
      }
    });
    const checkPath = () =>
      page.locator(".workspace-file-path").evaluate((nav) => {
        const buttons = [...nav.querySelectorAll("button")];
        const r = nav.getBoundingClientRect(),
          last = buttons.at(-1)!.getBoundingClientRect();
        return {
          scroll: nav.scrollLeft,
          overflow: nav.scrollWidth > nav.clientWidth,
          lastVisible: last.x >= r.x - 1 && last.right <= r.right + 1,
          contained: buttons.every((button) => {
            const range = document.createRange();
            range.selectNodeContents(button.querySelector(".ui-button__label")!);
            const ink = range.getBoundingClientRect(),
              box = button.getBoundingClientRect();
            return ink.x >= box.x - 0.5 && ink.right <= box.right + 0.5;
          }),
        };
      });
    const path = await checkPath();
    assert.ok(path.overflow && path.contained && path.lastVisible, JSON.stringify(path));
    const oldPath = await page.addStyleTag({ content: ".workspace-file-path > .ui-button{flex:0 1 auto}" });
    assert.equal((await checkPath()).contained, false, "negative control must reproduce the overlapping long path");
    await oldPath.evaluate((node) => node.remove());
    await page.locator(".workspace-file-path").evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    assert.ok((await checkPath()).lastVisible);
    await page.screenshot({ path: output + "/file-path.png" });
    const navBox = await page.locator(".workspace-file-path").boundingBox();
    const scrollBefore = await page.locator(".workspace-file-path").evaluate((n) => n.scrollLeft);
    const y = navBox!.y + navBox!.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 60, y }] });
    for (let x = 70; x <= 220; x += 10) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(
      (before) => document.querySelector(".workspace-file-path")!.scrollLeft < before,
      scrollBefore,
    );
    await page.waitForTimeout(550); // Let the Shell's existing post-drag click guard expire.
    // Keyboard traversal reaches the path root and invokes the same navigation.
    await page.locator(".workspace-file-path button").first().focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".workspace-file-path button").count(), 1);
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      for (const id of ["confirmation-1", "confirmation-2", "confirmation-3"]) p.open("scope", "terminal", { id });
    });
    await page.locator(".panel-mobile-dock__tabs").click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    if (process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER)
      assert.ok((await page.locator('[data-retained-preview-presentation="popover"]').count()) > 0);
    const mounts = await page.evaluate(() => (window as any).fixture.terminalMounts());
    for (const theme of ["light", "dark", "custom"]) {
      await page.evaluate((theme) => {
        const f = (window as any).fixture;
        if (theme === "custom") f.customTheme();
        else f.setThemePreference(theme);
      }, theme);
      await page.evaluate(() => (window as any).showSideChatClose());
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      const native = await page.evaluate(() => typeof HTMLElement.prototype.showPopover === "function");
      if (native)
        await page.waitForFunction(() => document.querySelector(".modal-confirmation")?.matches(":popover-open"));
      const layout = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect(),
          body = node.querySelector(".modal-confirmation__body")!;
        const range = document.createRange();
        range.selectNodeContents(body);
        const ink = [...range.getClientRects()];
        const actions = [...node.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
        return {
          size: (node as HTMLElement).dataset.size,
          width: rect.width,
          within: rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
          text: ink.every((r) => r.x > rect.x && r.right < rect.right),
          actions: actions.every((r) => r.x >= rect.x && r.right <= rect.right && r.bottom <= rect.bottom),
          focused: node.contains(document.activeElement),
        };
      });
      assert.equal(layout.size, "compact");
      assert.ok(layout.within && layout.text && layout.actions && layout.focused, JSON.stringify(layout));
      // A late native thumbnail/flight cannot overtake the confirmation pair.
      if (native)
        await page.evaluate(() => {
          const node = document.createElement("div");
          node.id = "late-native-plane";
          node.setAttribute("popover", "manual");
          Object.assign(node.style, {
            position: "fixed",
            inset: "0",
            margin: "0",
            width: "100vw",
            height: "100vh",
            background: "magenta",
          });
          document.body.append(node);
          node.showPopover();
        });
      assert.ok(
        await dialog.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      );
      await page.evaluate(() => document.getElementById("late-native-plane")?.remove());
      await page.screenshot({ path: output + "/sidechat-" + theme + ".png" });
      await page.keyboard.press("Tab");
      assert.ok(await dialog.evaluate((n) => n.contains(document.activeElement)));
      const cancel = dialog.locator("button").first();
      await cancel.tap();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => (window as any).sideChatCloseCount ?? 0), 0);
      assert.equal(
        await page.evaluate(() => (window as any).fixture.terminalMounts()),
        mounts,
        "cancel preserves live terminal instances",
      );
    }
    await page.evaluate(() => (window as any).showSideChatClose());
    await page.getByRole("alertdialog").waitFor();
    await page.waitForFunction(() => document.querySelector(".modal-confirmation")?.contains(document.activeElement));
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "hidden" });
    await page.evaluate(() => (window as any).showSideChatClose());
    const confirm = page.getByRole("alertdialog").locator("button").last();
    assert.equal(await confirm.getAttribute("data-variant"), "destructive");
    await confirm.tap();
    await page.getByRole("alertdialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as any).sideChatCloseCount), 1);
    assert.equal(await page.locator(".modal-confirmation[popover]").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        ok: true,
        confirmation: true,
        path: true,
        locale: process.env.OPENCRAFT_TEST_LOCALE ?? "zh-CN",
        nativeFallback: !!process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER,
        output,
      }),
    );
  } else if (process.env.OPENCRAFT_OVERVIEW_SCRIM_ONLY) {
    await page.evaluate(() => (window as any).scene.selectPrimary());
    await page.getByTestId("composer-panel-toggle").waitFor();
    await page.evaluate(() => {
      const w = window as any;
      w.scrimFrames = [];
      const sample = () => {
        const surface = document.querySelector<HTMLElement>(".panel-mobile-sheet--tabs");
        if (surface) {
          const scrim = surface.previousElementSibling!;
          w.scrimFrames.push({
            presentation: surface.dataset.presentation,
            phase: document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase,
            canvas: Number(getComputedStyle(surface, "::before").opacity),
            paint: getComputedStyle(scrim).backgroundColor,
            dimmed: (scrim as HTMLElement).dataset.dimmed,
            surfaceShadow: getComputedStyle(surface).boxShadow,
            flight: (() => {
              const frame = document.querySelector<HTMLElement>("[data-overview-flight]");
              if (!frame) return null;
              const css = getComputedStyle(frame);
              return {
                background: css.backgroundColor,
                filter: css.backdropFilter,
                kind: frame.dataset.tabKind ?? "primary",
                borderWidth:
                  parseFloat(getComputedStyle(frame, "::after").borderTopWidth) *
                  Number(getComputedStyle(frame, "::after").opacity),
                layoutBorder: parseFloat(css.borderTopWidth),
                borderColor: getComputedStyle(frame, "::after").borderTopColor,
                shadow: css.getPropertyValue("--overview-frame-shadow").trim() || css.boxShadow,
                clip: css.clipPath,
                radius: parseFloat(css.borderTopLeftRadius),
                backdrop: getComputedStyle(frame, "::backdrop").backgroundColor,
              };
            })(),
          });
        }
        if (!w.stopScrimFrames) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const inspectFlight = async (label: string) => {
      await page.waitForFunction(() => !!document.querySelector("[data-overview-flight]"));
      for (const time of [0.08, 0.12, 0.18]) {
        await page.evaluate((time) => {
          (window as any).scenePlayback.time = time;
        }, time);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      }
      await page.screenshot({ path: output + "/" + label + "-material.png" });
      await page.evaluate(() => (window as any).scenePlayback.play());
    };
    for (const reduced of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion: reduced });
      if (reduced === "no-preference") await page.evaluate(() => ((window as any).pauseNextScene = true));
      await page.getByTestId("composer-panel-toggle").click();
      if (reduced === "no-preference") await inspectFlight("entering");
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
      if (reduced === "no-preference") {
        const settled = await page.locator(".panel-overview-primary").evaluate((frame) => ({
          background: getComputedStyle(frame).backgroundColor,
          filter: getComputedStyle(frame).backdropFilter,
        }));
        const last = await page.evaluate(() => {
          const frames = (window as any).scrimFrames.filter(
            (f: any) => f.flight?.kind === "primary" && f.phase === "entering",
          );
          return frames.at(-1)?.flight;
        });
        assert.ok(last);
        assert.equal(last.background, settled.background, "primary handback keeps the same scene paint");
        assert.equal(settled.filter, "none");
        assert.equal(last.filter, settled.filter, "primary never switches to frosted material");
      }
      if (reduced === "no-preference") await page.evaluate(() => ((window as any).pauseNextScene = true));
      await page.locator(".panel-overview-primary .ui-object-title-button").click();
      if (reduced === "no-preference") await inspectFlight("exiting");
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      (window as any).fixture.panels.open("scope", "terminal", { id: "border-terminal" });
    });
    await page.locator(".panel-mobile-dock__tabs").waitFor();
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), theme);
      await page.evaluate(() => ((window as any).pauseNextScene = true));
      await page.locator(".panel-mobile-dock__tabs").click();
      await inspectFlight("terminal-" + theme + "-entering");
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
      const settled = await page.locator('.panel-overview-card[data-tab-id="border-terminal"]').evaluate((frame) => ({
        width: parseFloat(getComputedStyle(frame, "::after").borderTopWidth),
        color: getComputedStyle(frame, "::after").borderTopColor,
        background: getComputedStyle(frame).backgroundColor,
        filter: getComputedStyle(frame).backdropFilter,
        frame: frame.getBoundingClientRect().toJSON(),
        preview: frame.querySelector("[data-overview-view]")!.getBoundingClientRect().toJSON(),
        topRadius: getComputedStyle(frame.querySelector("[data-overview-view]")!).borderTopLeftRadius,
        bottomRadius: getComputedStyle(frame.querySelector("[data-overview-view]")!).borderBottomLeftRadius,
        cardRadius: getComputedStyle(frame).borderBottomLeftRadius,
      }));
      const last = await page.evaluate(() => {
        const samples = (window as any).scrimFrames.filter(
          (f: any) => f.flight?.kind === "terminal" && f.phase === "entering",
        );
        return samples.at(-1)?.flight;
      });
      assert.ok(
        last && last.borderWidth > 0 && Math.abs(last.borderWidth - settled.width) < 0.02,
        "cleanup cannot be the first frame with terminal border",
      );
      assert.equal(last.borderColor, settled.color, "handback preserves terminal border material");
      assert.equal(last.background, settled.background, "cleanup must not switch scene background");
      assert.equal(last.filter, settled.filter, "cleanup must not introduce a glass filter");
      assert.equal(settled.filter, "none", "scene cards have no second material owner");
      assert.equal(settled.topRadius, "0px");
      assert.equal(
        settled.bottomRadius,
        settled.cardRadius,
        "full-width native preview preserves the outer bottom aperture",
      );
      const composition = await page
        .locator('.panel-overview-card[data-tab-id="border-terminal"]')
        .evaluate((frame) => {
          const native = frame.querySelector(".retained-preview-decoration"),
            view = document.querySelector('[data-retained-preview-presentation="popover"][data-retained-view="panel"]');
          return {
            external: (frame as HTMLElement).dataset.overviewDecorationOwner,
            frameShadow: getComputedStyle(frame).boxShadow,
            decoration: native
              ? {
                  shadow: getComputedStyle(native).boxShadow,
                  opacity: getComputedStyle(native).opacity,
                  backdrop: getComputedStyle(native, "::backdrop").backgroundColor,
                  rect: native.getBoundingClientRect().toJSON(),
                  border: getComputedStyle(native, "::after").borderTopColor,
                }
              : null,
            controls: [...(view ?? frame).querySelectorAll("[data-retained-preview-chrome]")].map(
              (n) => getComputedStyle(n).visibility,
            ),
          };
        });
      assert.ok(
        composition.controls.length > 0 && composition.controls.every((v) => v === "hidden"),
        "read-only resource preview excludes its input controls",
      );
      if (process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER) {
        assert.equal(composition.external, "external");
        assert.equal(composition.frameShadow, "none", "one decoration owner");
        assert.ok(composition.decoration && composition.decoration.shadow !== "none");
        assert.equal(composition.decoration.backdrop, "rgba(0, 0, 0, 0)");
        assert.ok(
          Math.abs(composition.decoration.rect.height - settled.frame.height) < 0.1 &&
            Math.abs(composition.decoration.rect.y - settled.frame.y) < 0.1,
          "decoration spans the entire card, including terminal body",
        );
        assert.equal(composition.decoration.border, settled.color);
      }
      assert.ok(
        Math.abs(settled.preview.x - settled.frame.x) < 0.1 &&
          Math.abs(settled.preview.width - settled.frame.width) < 0.1,
        "native preview fills the card width without an inset box",
      );
      assert.ok(
        Math.abs(settled.preview.y + settled.preview.height - settled.frame.y - settled.frame.height) < 0.1,
        "native preview fills the card down to the bottom edge",
      );
      await page.evaluate(() => ((window as any).pauseNextScene = true));
      await page.locator('.panel-overview-card[data-tab-id="border-terminal"] .ui-object-title-button').click();
      await inspectFlight("terminal-" + theme + "-exiting");
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      assert.equal(
        await page.locator(".retained-preview-decoration").count(),
        0,
        "handback releases all native decoration leases",
      );
      assert.equal(await page.locator("[data-overview-decoration-owner]").count(), 0);
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      p.open("scope", "terminal", { id: "scrim-contained" });
      if (p.getOwnerSnapshot("scope").rightPanelFullWidth) p.dispatch("scope", { type: "toggle-right-full-width" });
      p.dispatch("scope", { type: "set-region-open", region: "right", open: true });
    });
    await page.locator("[data-wide-primary] button").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.screenshot({ path: output + "/contained-scrim.png" });
    const contained = await page.locator(".panel-mobile-sheet--tabs").evaluate((surface) => ({
      presentation: (surface as HTMLElement).dataset.presentation,
      paint: getComputedStyle(surface.previousElementSibling!).backgroundColor,
      dimmed: (surface.previousElementSibling as HTMLElement).dataset.dimmed,
    }));
    assert.equal(contained.presentation, "adaptive-sheet");
    assert.equal(contained.dimmed, "true");
    assert.notEqual(contained.paint, "rgba(0, 0, 0, 0)", "contained overview retains the normal modal dim");
    await page.keyboard.press("Escape");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    const frames = await page.evaluate(() => {
      (window as any).stopScrimFrames = true;
      return (window as any).scrimFrames;
    });
    await writeFile(output + "/scrim-frames.json", JSON.stringify(frames, null, 2));
    const full = frames.filter((f: any) => f.presentation === "fullscreen");
    assert.ok(full.length > 10);
    assert.ok(
      full.every((f: any) => f.paint === "rgba(0, 0, 0, 0)" && f.dimmed === "false"),
      "fullscreen has no hidden black scrim at any point",
    );
    for (const phase of ["entering", "exiting"])
      assert.ok(
        full.some((f: any) => f.phase === phase && f.canvas > 0 && f.canvas < 1),
        "canvas interpolates through " + phase,
      );
    assert.ok(
      full.every((f: any) => f.surfaceShadow === "none"),
      "fullscreen canvas must not inherit floating-dialog elevation",
    );
    const flights = full.filter((f: any) => f.flight);
    assert.ok(
      flights.some((f: any) => /[-][\d.]+px/.test(f.flight.clip)),
      "flight aperture leaves room for card decoration",
    );
    assert.ok(
      new Set(flights.map((f: any) => f.flight.shadow)).size > 3,
      "theme elevation follows the same continuous geometry clock",
    );
    assert.ok(
      flights.every((f: any) => f.flight.filter === "none"),
      "scene frame material cannot acquire blur on lift or cleanup",
    );
    assert.ok(
      flights.every((f: any) => f.flight.layoutBorder === 0),
      "border paint never changes the native containing block",
    );
    assert.ok(
      flights.filter((f: any) => f.flight.radius > 2).every((f: any) => f.flight.borderWidth > 0),
      "border is present during geometry, never deferred to spring completion",
    );
    assert.ok(
      flights.every((f: any) => f.flight.backdrop === "rgba(0, 0, 0, 0)"),
      "native lifting must not introduce a backdrop",
    );
    assert.deepEqual(errors, []);
    console.log("PASS overview backdrop: primary entry/return, one fullscreen canvas, contained dim, reduced motion");
  } else if (process.env.OPENCRAFT_OVERVIEW_OWNER_ONLY) {
    await page.evaluate(() => (window as any).scene.selectPrimary());
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.marker === 1);
    const before = await page.evaluate(() => {
      const w = window as any;
      w.ownerChat = document.querySelector("[data-real-chat]");
      document.querySelector("iframe")!.contentWindow!.marker = 91;
      return w.fixture.frameLoads();
    });
    for (const owner of ["other", "scope", "other", "scope"]) {
      await page.evaluate((owner) => (window as any).setFixtureOwner(owner), owner);
      await page.waitForFunction((owner) => (window as any).scene.sceneOwnerId === owner, owner);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(
        await page.evaluate(() => document.querySelector("iframe")?.contentWindow?.marker),
        91,
        "changing the registry identity must not detach the live chat surface",
      );
    }
    assert.equal(
      await page.evaluate(() => (window as any).fixture.frameLoads()),
      before,
      "owner changes must not reload embedded documents",
    );
    assert.equal(
      await page.evaluate(() => document.querySelector("[data-real-chat]") === (window as any).ownerChat),
      true,
    );
    assert.deepEqual(errors, []);
    console.log("PASS owner switch: connected portal, original DOM and iframe state");
  } else if (process.env.OPENCRAFT_OVERVIEW_LEASE_ONLY) {
    const reentrant = await page.evaluate(() => {
      const w = window as any;
      const owner = w.overview.destination.ownerId;
      const key = JSON.stringify(["primary-chat", owner]);
      const prepare = () => w.overview.prepare(owner, key, new AbortController().signal);
      const old = prepare();
      let newest: any;
      old.signal.addEventListener("abort", () => {
        newest = prepare();
      });
      const interrupted = prepare();
      const obsolete = w.overview.prepare("obsolete-owner", key, new AbortController().signal);
      const result = {
        interrupted: interrupted.signal.aborted,
        newest: newest.signal.aborted,
        obsolete: obsolete.signal.aborted,
      };
      newest.cancel();
      return result;
    });
    assert.deepEqual(
      reentrant,
      { interrupted: true, newest: false, obsolete: true },
      "cleanup and obsolete callers must preserve the newest preparation",
    );
    await page.waitForFunction(() => (window as any).overview.preparedScene === null);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      const w = window as any;
      w.fixture.panels.open("scope", "browser", {});
      w.scene.selectPrimary();
      w.holdBrowserPresentation = true;
    });
    await page.waitForFunction(() => (window as any).scene.contentPresentation === "primary");
    await page.getByTestId("composer-panel-toggle").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.locator('[data-tab-kind="browser"] .ui-object-title-button').click();
    await page.waitForFunction(
      () => document.querySelector("[data-overview-phase=preparing]") && (window as any).releaseBrowserPresentation,
    );
    await page.evaluate(() => {
      const w = window as any;
      w.oldLease = w.overview.preparedScene;
      w.lateReady = w.releaseBrowserPresentation;
      w.overview.dismiss();
    });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.evaluate(() => {
      const w = window as any;
      w.lateReady();
    });
    assert.equal(await page.evaluate(() => (window as any).oldLease.signal.aborted), true);
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").foreground),
      "primary",
    );
    await page.getByTestId("composer-panel-toggle").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.locator('[data-tab-kind="browser"] .ui-object-title-button').click();
    await page.waitForFunction(() => document.querySelector("[data-overview-phase=preparing]"));
    await page.evaluate(async () => {
      const w = window as any;
      w.readyLease = w.overview.preparedScene;
      w.pauseNextScene = true;
      w.releaseBrowserPresentation();
      await w.readyLease.ready;
    });
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=exiting]"));
    await page.evaluate(() => (window as any).setFixtureOwner("other"));
    await page.waitForFunction(() => (window as any).scene.sceneOwnerId === "other");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(
      await page.evaluate(() =>
        (window as any).readyLease.commit(() => {
          throw Error("Stale commit executed");
        }),
      ),
      false,
    );
    assert.equal(await page.locator("[data-overview-flight]").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).overview.preparedScene), null);
    assert.equal(await page.evaluate(() => (window as any).overview.chromeOpacity.get()), 1);
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").foreground),
      "primary",
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: output + "/lease-owner-return.png" });
    console.log(
      "PASS scene lease: cancelled readiness, post-ready owner replacement, no stale selection or stranded geometry",
    );
  } else if (process.env.OPENCRAFT_OVERVIEW_HEADING_ONLY) {
    await page.evaluate(() => (window as any).scene.selectPrimary());
    await page.getByTestId("composer-panel-toggle").waitFor();
    // Await a stable hit target; scene allocation can still be moving on entry.
    const tap = (selector: string) => page.locator(selector).tap();
    // This geometry-only mode retains the visually settled paused flight for
    // endpoint sampling/rewind. MOTION/RESPONSIVENESS exercise actual early release.
    const reports: any[] = [];
    for (const { theme, width, touch } of [
      { theme: "light", width: 390, touch: true },
      { theme: "dark", width: 390, touch: true },
      { theme: "custom", width: 390, touch: true },
      { theme: "light", width: 1024, touch: true },
      { theme: "dark", width: 390, touch: false },
    ]) {
      const caseName = theme + "-" + width + "-" + (touch ? "touch" : "mouse");
      await page.setViewportSize({ width, height: 844 });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: touch });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch });
      // Input modality can change without replacing the touch presentation.
      await page.evaluate(() => (document.documentElement.dataset.uiDensity = "touch"));
      await page.evaluate(
        (theme) =>
          theme === "custom"
            ? (window as any).fixture.customTheme()
            : (window as any).fixture.setThemePreference(theme),
        theme,
      );
      await page.evaluate(() => ((window as any).pauseNextScene = true));
      if (width === 390) {
        if (touch) await tap('[data-testid="composer-panel-toggle"]');
        else await page.getByTestId("composer-panel-toggle").click();
      } else
        await page.evaluate(() => {
          const w = window as any;
          w.overview.show({ key: JSON.stringify(["primary-chat", "scope"]), rect: w.scene.sceneBounds("primary") });
        });
      await page.waitForFunction(() => !!document.querySelector("[data-overview-flight]"));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const samples = await page.evaluate(async () => {
        const w = window as any,
          rows = [];
        for (let i = 0; i <= 350; i += 5) {
          w.scenePlayback.time = i / 1000;
          await new Promise(requestAnimationFrame);
          const frame = document.querySelector<HTMLElement>("[data-overview-flight]")!;
          rows.push({ time: i / 1000, ...w.readHeading(frame) });
        }
        return rows;
      });
      const final = samples.at(-1),
        half = samples.find((r) => r.content.y - r.frame.y >= 0.65 * (final.content.y - final.frame.y));
      assert.ok(
        half.opacity > 0.2,
        "title becomes readable during band formation, rather than popping in after most geometry is complete",
      );
      const partial = samples.filter((r) => r.opacity > 0.1 && r.opacity < 0.9);
      assert.ok(
        partial.length > 3 &&
          partial.at(-1).content.y - partial.at(-1).frame.y - partial[0].content.y + partial[0].frame.y >
            0.2 * (final.content.y - final.frame.y),
        "reveal spans a range of the shared geometry",
      );
      for (const r of samples)
        if (r.opacity > 0.01) {
          assert.ok(
            r.inkTop >= r.frame.y - 1 && r.inkBottom <= r.content.y + 1,
            "whole glyphs fit between frame top and content aperture",
          );
        }
      await page.evaluate(() => ((window as any).scenePlayback.time = 0.1));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (theme === "light" && width === 390) {
        const rebase = await page.evaluate(async () => {
          const w = window as any,
            frame = document.querySelector<HTMLElement>("[data-overview-flight]")!;
          const layout = document.querySelector<HTMLElement>(".panel-overview-layout")!;
          const before = w.readHeading(frame);
          layout.style.setProperty("--padding-tool-overview-page", "48px");
          window.dispatchEvent(new Event("resize"));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = w.readHeading(frame);
          layout.style.removeProperty("--padding-tool-overview-page");
          window.dispatchEvent(new Event("resize"));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { before, after, restored: w.readHeading(frame) };
        });
        for (const row of [rebase.after, rebase.restored]) {
          for (const k of ["x", "y", "width", "height"])
            assert.ok(Math.abs(row.rect[k] - rebase.before.rect[k]) < 0.1, "rebase anchors painted title " + k);
          assert.ok(Math.abs(row.opacity - rebase.before.opacity) < 0.01, "rebase preserves painted title opacity");
        }
      }
      await writeFile(
        output + "/heading-" + caseName + "-middle.json",
        JSON.stringify(
          await page.evaluate(() => (window as any).readHeading(document.querySelector("[data-overview-flight]"))),
          null,
          2,
        ),
      );
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(output + "/heading-" + caseName + "-middle.png", Buffer.from(shot.data, "base64"));
      await page.evaluate(() => (window as any).scenePlayback.complete());
      await page.waitForFunction(() => !document.querySelector("[data-overview-flight]"));
      const settled = await page
        .locator(".panel-overview-primary")
        .evaluate((frame) => (window as any).readHeading(frame));
      for (const k of ["x", "y", "width", "height"])
        assert.ok(Math.abs(final.rect[k] - settled.rect[k]) < 0.1, "removing flight styles cannot change title " + k);
      assert.equal(settled.opacity, 1);
      await page.evaluate(() => ((window as any).pauseNextScene = true));
      if (touch) await tap(".panel-overview-primary .ui-object-title-button");
      else await page.locator(".panel-overview-primary .ui-object-title-button").click();
      await page.waitForFunction(() => !!document.querySelector("[data-overview-flight]"));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const reverse = await page.evaluate(async () => {
        const w = window as any,
          rows = [];
        for (let i = 0; i <= 350; i += 5) {
          w.scenePlayback.time = i / 1000;
          await new Promise(requestAnimationFrame);
          const f = document.querySelector<HTMLElement>("[data-overview-flight]");
          if (!f) break;
          rows.push({ time: i / 1000, ...w.readHeading(f) });
        }
        return rows;
      });
      for (const [i, r] of reverse.entries()) {
        assert.ok(i === 0 || r.opacity <= reverse[i - 1].opacity + 0.01, "title leaves continuously on expansion");
        if (r.opacity > 0.01)
          assert.ok(
            r.inkTop >= r.frame.y - 1 && r.inkBottom <= r.content.y + 1,
            "expansion also preserves whole glyphs",
          );
      }
      await page.waitForFunction(() => !document.querySelector(".panel-mobile-sheet--tabs"));
      await page.evaluate(() => (window as any).scenePlayback.complete());
      await page.waitForFunction(() => (window as any).overview.chromeOpacity.get() === 1);
      reports.push({ theme, width, touch, halfOpacity: half.opacity, samples, reverse, settled });
    }
    await writeFile(output + "/heading-frames.json", JSON.stringify(reports, null, 2));
    assert.deepEqual(errors, []);
    console.log(
      "PASS title band: early continuous ink reveal, reversible geometry, unchanged cleanup, light/dark/custom, phone/tablet/mouse",
    );
  } else if (process.env.OPENCRAFT_OVERVIEW_MOTION_ONLY) {
    await page.evaluate(async () => {
      const { suspendSceneChrome } = await import("/apps/workbench-web/src/components/scene-chrome-inert.ts");
      const root = document.createElement("div");
      root.className = "app-shell-root";
      document.body.append(root);
      const make = () => {
        const n = document.createElement("div");
        n.className = "panel-mobile-dock";
        root.append(n);
        return n;
      };
      const a = make(),
        b = make();
      b.inert = true;
      const release = suspendSceneChrome(root);
      a.inert = true;
      b.inert = false;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      if (!a.inert || !b.inert) throw Error("presentation must remain inert despite external writes");
      const c = make();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      if (!c.inert) throw Error("new chrome must join the active lease");
      // Same-turn write and release must not lose the pending external update.
      c.inert = true;
      release();
      if (!a.inert || b.inert || !c.inert) throw Error("release must preserve latest external inert intent");
      root.remove();
    });
    await page.evaluate(() => {
      const w = window as any;
      w.surfaceFrames = [];
      const capture = () => {
        const frame = document.querySelector<HTMLElement>("[data-overview-flight]"),
          surface = document.querySelector<HTMLElement>(".panel-mobile-sheet--tabs");
        if (frame && surface) {
          const preview = frame.querySelector<HTMLElement>("[data-overview-view]");
          const bounds = frame.getBoundingClientRect(),
            content = preview?.getBoundingClientRect();
          if (
            !frame.classList.contains("panel-overview-card") ||
            !content ||
            content.left < bounds.left - 1 ||
            content.right > bounds.right + 1 ||
            content.top < bounds.top - 1 ||
            content.bottom > bounds.bottom + 1
          )
            w.invalidSurface = true;
          const scrim = surface.previousElementSibling!;
          w.surfaceFrames.push({
            phase: document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase,
            backdrop: Number(getComputedStyle(surface, "::before").opacity),
            scrim: Number(getComputedStyle(scrim).opacity),
            scrimPaint: getComputedStyle(scrim).backgroundColor,
            fullscreen: surface.dataset.presentation === "fullscreen",
            radius: parseFloat(getComputedStyle(frame).borderTopLeftRadius),
            background: getComputedStyle(surface).backgroundColor,
            headingOpacity: Number(getComputedStyle(frame.querySelector(".panel-overview-card__heading")!).opacity),
            headingClip: getComputedStyle(frame.querySelector(".panel-overview-card__heading")!).clipPath,
            headingBottom: (window as any).readHeading(frame).inkBottom,
            headingTop: (window as any).readHeading(frame).inkTop,
            frameTop: bounds.top,
            contentTop: preview?.getBoundingClientRect().top,
            contentRadius: preview ? parseFloat(getComputedStyle(preview).borderTopLeftRadius) : 0,
            raster: !preview?.querySelector(".retained-view-preview"),
            frameOpacity: Number(getComputedStyle(frame).opacity),
            width: bounds.width,
          });
        }
        if (!w.stopSurfaceCapture) requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    });
    const assertSettledScene = async (selector: string) => {
      const samples = await page.evaluate(async (selector) => {
        const values: { x: number; width: number }[] = [];
        for (let i = 0; i < 18; i++) {
          await new Promise(requestAnimationFrame);
          const r = document.querySelector(selector)!.getBoundingClientRect();
          values.push({ x: r.x, width: r.width });
        }
        return values;
      }, selector);
      assert.ok(
        Math.max(...samples.map((r) => r.x)) - Math.min(...samples.map((r) => r.x)) < 1,
        "overview handoff must not replay a horizontal pane slide",
      );
      assert.ok(
        Math.max(...samples.map((r) => r.width)) - Math.min(...samples.map((r) => r.width)) < 1,
        "overview handoff must not replay pane resizing",
      );
    };

    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("[data-overview-phase]") && (window as any).scene.contentPresentation === "primary",
    );
    await page.locator("[data-real-chat] input").fill("Motion preserves draft");
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.marker === 1);
    await page.evaluate(() => {
      (window as any).motionChat = document.querySelector("[data-real-chat]");
      (document.querySelector("iframe")!.contentWindow as any).marker = 91;
    });
    const captureFlight = async (name: string) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(output + "/" + name + ".png", Buffer.from(shot.data, "base64"));
    };
    const sample = () =>
      page.evaluate(() => {
        const e = document.querySelector<HTMLElement>("[data-overview-flight]");
        const r = e?.getBoundingClientRect();
        return {
          radius: e ? parseFloat(getComputedStyle(e).borderTopLeftRadius) : null,
          opacity: Number(
            getComputedStyle(
              document.querySelector(".panel-overview-card--create") ?? document.querySelector(".panel-overview-card")!,
            ).opacity,
          ),
          phase: document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase,
          backdrop: Number(
            document
              .querySelector<HTMLElement>(".panel-mobile-sheet--tabs")
              ?.style.getPropertyValue("--overview-surface-opacity") || 1,
          ),
          rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        };
      });
    // Sample the real Motion spring with its public playback clock. Expensive
    // headless capture must not turn geometry assertions into a wall-clock FPS gate.
    const measureFlight = (selector: string) =>
      page.evaluate(async (selector) => {
        const samples: any[] = [];
        let viewportStayedLive = true;
        const w = window as any;
        w.pauseNextScene = true;
        w.pauseSceneTime = 0;
        document.querySelector<HTMLButtonElement>(selector)!.click();
        for (let i = 0; i < 120; i++) {
          if (samples.length) {
            w.scenePlayback.time = samples.length / 60;
            if (w.scenePlayback.time >= w.scenePlayback.duration) w.scenePlayback.complete();
          }
          await new Promise(requestAnimationFrame);
          const node = document.querySelector<HTMLElement>("[data-overview-flight]");
          if (!node) {
            if (samples.length) break;
            continue;
          }
          const r = node.getBoundingClientRect(),
            phase = document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase;
          if (phase === "exiting" && !samples.length) {
            window.visualViewport?.dispatchEvent(new Event("resize"));
            viewportStayedLive = !!document.querySelector("[data-overview-phase=exiting]");
          }
          const card = document.querySelector(".panel-overview-primary"),
            live = document.querySelector('[data-retained-view="primary-chat"]');
          samples.push({
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            phase,
            fades:
              card && live
                ? { card: Number(getComputedStyle(card).opacity), live: Number(getComputedStyle(live).opacity) }
                : null,
          });
        }
        // A physical spring can spend many frames settling after its geometry is
        // clamped at the endpoint. Inspect a geometric midpoint, not a time index
        // that can already be in that tail on a slower renderer.
        const midpoint = (samples[0]?.rect.width + samples.at(-1)?.rect.width) / 2;
        const middle = samples.reduce(
          (best, row) => (Math.abs(row.rect.width - midpoint) < Math.abs(best.rect.width - midpoint) ? row : best),
          samples[0],
        );
        delete w.pauseSceneTime;
        w.scenePlayback.complete();
        return { start: samples[0], middle, viewportStayedLive, count: samples.length };
      }, selector);
    const entry = await measureFlight('[data-testid="composer-panel-toggle"]');
    const enteringStart = entry.start,
      enteringMiddle = entry.middle;
    assert.ok(
      entry.count > 2 && enteringStart.rect.width > enteringMiddle.rect.width,
      "opening shrinks the current scene toward its card: " + JSON.stringify(entry),
    );
    await captureFlight("entering");
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.screenshot({ path: output + "/settled-title.png" });
    const heading = page.locator(".panel-overview-primary .panel-overview-card__heading");
    await heading.getByRole("button", { name: "Main chat", exact: true }).waitFor({ state: "visible" });
    const headingBox = await heading.boundingBox();
    const previewBox = await page.locator(".panel-overview-primary [data-overview-view]").boundingBox();
    assert.ok(
      headingBox && previewBox && previewBox.y >= headingBox.y + headingBox.height - 1,
      "preview never overlaps card heading after flight",
    );
    const card = await page.locator(".panel-overview-primary [data-overview-view]").boundingBox();
    assert.ok(card);
    assert.ok(enteringMiddle.rect.width > card.width);
    const exit = await measureFlight(".panel-overview-primary .ui-object-title-button");
    const exitingStart = exit.start,
      exitingMiddle = exit.middle;
    assert.ok(
      exit.count > 2 && exitingMiddle.rect.width > exitingStart.rect.width,
      "the selected card expands from its own position",
    );
    assert.ok(exit.viewportStayedLive, "viewport notifications retarget instead of committing navigation");
    await captureFlight("exiting");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-real-chat]").evaluate((e) => e === (window as any).motionChat), true);
    assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "Motion preserves draft");
    assert.equal(await page.locator("iframe").evaluate((e) => (e as HTMLIFrameElement).contentWindow!.marker), 91);
    await page.waitForFunction(() => (window as any).overview.chromeOpacity.get() === 1);
    const momentum = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="composer-panel-toggle"]')!.click();
      const widths: number[] = [];
      for (let i = 0; i < 60; i++) {
        await new Promise(requestAnimationFrame);
        const frame = document.querySelector<HTMLElement>("[data-overview-flight]");
        if (!frame) continue;
        const width = frame.getBoundingClientRect().width;
        widths.push(width);
        if (width < window.innerWidth - 10 && width > 170) {
          document.querySelector<HTMLButtonElement>(".panel-overview-primary .ui-object-title-button")!.click();
          const samples = [frame.getBoundingClientRect().width];
          for (let j = 0; j < 3; j++) {
            await new Promise(requestAnimationFrame);
            const f = document.querySelector("[data-overview-flight]");
            if (f) samples.push(f.getBoundingClientRect().width);
          }
          return samples;
        }
      }
      throw new Error("No reversal opportunity: " + JSON.stringify({ widths, viewport: window.innerWidth }));
    });
    await writeFile(output + "/momentum.json", JSON.stringify(momentum));
    const reversal = await page.evaluate(() => (window as any).sceneDriverHistory.at(-1));
    await writeFile(output + "/reversal-driver.json", JSON.stringify(reversal));
    assert.ok(
      reversal.target === 0 && reversal.from > 0 && reversal.from < 1 && reversal.velocity > 0,
      "reverse spring inherits outgoing momentum rather than restarting from rest",
    );
    assert.ok(momentum.length > 1, "sample the visible reversal as well as its driver");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    // Modal restoration must wait for chrome to release its inert lease.
    await page.waitForFunction(() => (window as any).overview.chromeOpacity.get() === 1);
    await page.getByTestId("composer-panel-toggle").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.keyboard.press("Escape");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('[data-testid="composer-panel-toggle"]'),
    );
    // Streaming while borrowed preserves the user's reading intent, not an old pixel tail.
    for (const follow of [true, false]) {
      await page.locator("[data-real-chat]").evaluate((node, follow) => {
        node.scrollTop = follow ? node.scrollHeight : 50;
      }, follow);
      await page.getByTestId("composer-panel-toggle").evaluate((node) => node.click());
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
      await page.locator("[data-real-chat]").evaluate((node) => {
        const message = document.createElement("p");
        message.textContent = "Message delivered while viewing overview";
        message.style.height = "200px";
        node.append(message);
      });
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      const position = await page
        .locator("[data-real-chat]")
        .evaluate((node) => ({ top: node.scrollTop, end: node.scrollHeight - node.clientHeight }));
      console.log("reading intent", follow, position);
      assert.ok(
        Math.abs(position.top - (follow ? position.end : 50)) < 2,
        "retained chat restores tail-following or history reading intent",
      );
    }
    // Reverse an opening from its current physical rectangle, not its endpoint.
    await page.getByTestId("composer-panel-toggle").click();
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=entering]"));
    await page.waitForTimeout(60);
    await page.evaluate(() => document.querySelector("[data-real-chat]")?.dispatchEvent(new Event("scroll")));
    assert.equal((await sample()).phase, "entering", "internal content scroll must not finish scene motion");
    const [beforeReverse, afterReverse] = await page.evaluate(() => {
      const read = () => {
        const e = document.querySelector<HTMLElement>("[data-overview-flight]")!;
        return {
          rect: { width: e.getBoundingClientRect().width },
          radius: parseFloat(getComputedStyle(e).borderTopLeftRadius),
          backdrop: Number(
            document
              .querySelector<HTMLElement>(".panel-mobile-sheet--tabs")!
              .style.getPropertyValue("--overview-surface-opacity"),
          ),
          opacity: Number(getComputedStyle(document.querySelector(".panel-overview-create")!).opacity),
        };
      };
      const before = read();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return [before, read()];
    });
    assert.ok(beforeReverse.rect && afterReverse.rect);
    assert.ok(
      Math.abs(beforeReverse.rect.width - afterReverse.rect.width) < 100,
      "reverse does not jump back to card width",
    );
    assert.ok(
      Math.abs(beforeReverse.backdrop - afterReverse.backdrop) < 0.2,
      "reversal preparation must preserve backdrop progress",
    );
    assert.ok(
      beforeReverse.radius !== null &&
        afterReverse.radius !== null &&
        Math.abs(beforeReverse.radius - afterReverse.radius) < 3,
      "reversal preserves radius",
    );
    assert.ok(Math.abs(beforeReverse.opacity - afterReverse.opacity) < 0.2, "reversal preserves siblings opacity");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.evaluate(() => {
      (window as any).fixture.panels.open("scope", "terminal", { id: "motion-terminal" });
    });
    await page.locator(".panel-mobile-dock__tabs").waitFor();
    await page.waitForTimeout(550);
    const mounts = await page.evaluate(() => (window as any).fixture.terminalMounts());
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.evaluate(() => {
      const w = window as any;
      w.handoffFrames = [];
      w.handoffGaps = [];
      w.stopHandoffCapture = false;
      const layout = document.querySelector(".panel-overview-layout")!;
      w.handoffObserver = new MutationObserver((records) => {
        if (
          records.some((r) => r.attributeName === "data-overview-phase" && r.oldValue === "exiting") &&
          layout.isConnected &&
          !layout.hasAttribute("data-overview-phase")
        )
          w.handoffGaps.push(
            document.querySelector(".panel-overview-primary [data-overview-view]")?.getBoundingClientRect().width,
          );
      });
      w.handoffObserver.observe(layout, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-overview-phase"],
      });
      const sample = () => {
        const dialog = document.querySelector(".panel-mobile-sheet--tabs");
        const frame = document.querySelector(".panel-overview-primary [data-overview-view]");
        w.handoffFrames.push({
          time: performance.now(),
          dialog: !!dialog,
          phase: document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase ?? null,
          width: frame?.getBoundingClientRect().width ?? null,
          chatX: document.querySelector("[data-real-chat]")?.getBoundingClientRect().x,
        });
        if (!w.stopHandoffCapture) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await assertSettledScene("[data-real-chat]");
    const handoffFrames = await page.evaluate(() => {
      (window as any).stopHandoffCapture = true;
      return (window as any).handoffFrames;
    });
    await writeFile(output + "/handoff-frames.json", JSON.stringify(handoffFrames, null, 2));
    const firstExit = handoffFrames.findIndex((f: any) => f.phase === "exiting");
    assert.ok(firstExit >= 0);
    const handoffGaps = await page.evaluate(() => {
      (window as any).handoffObserver.disconnect();
      return (window as any).handoffGaps;
    });
    assert.deepEqual(
      handoffGaps,
      [],
      "returning the view must not expose a restored card before the React destination commit",
    );
    assert.ok(
      !handoffFrames.slice(firstExit).some((f: any) => f.dialog && f.phase === null),
      "completed flight must never paint the thumbnail before handing back the scene",
    );
    await page.getByTestId("composer-panel-toggle").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const terminalMeasurement = await measureFlight(
      '.panel-overview-card[data-tab-kind="terminal"] .ui-object-title-button',
    );
    assert.ok(terminalMeasurement.count > 2, "terminal transition paints intermediate frames");
    const terminalFlight = terminalMeasurement.middle;
    assert.ok(
      terminalFlight.rect && terminalFlight.rect.x < 100 && terminalFlight.rect.x + terminalFlight.rect.width <= 391,
      "selected terminal expands into the visible scene, not its parked offscreen slot",
    );
    await page.screenshot({ path: output + "/terminal-exiting.png" });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await assertSettledScene(".right-panel-resident:not([hidden]) .terminal-panel");
    assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), mounts);
    // Image-backed tools have no retained source; their destination must still be
    // the visible scene, and native top-layer siblings must fade with their cards.
    await page.evaluate(() => (window as any).fixture.panels.open("scope", "browser", {}));
    await page.waitForTimeout(550);
    for (const fromChat of [false, true]) {
      if (fromChat) {
        await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
        await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
        await page.getByRole("button", { name: "Main chat", exact: true }).click();
        await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      }
      await page.locator(fromChat ? '[data-testid="composer-panel-toggle"]' : ".panel-mobile-dock__tabs").click();
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
      const browserCard = page.locator('.panel-overview-card[data-tab-kind="browser"]');
      await browserCard.locator("img").waitFor();
      const browserMeasurement = await measureFlight(
        '.panel-overview-card[data-tab-kind="browser"] .ui-object-title-button',
      );
      assert.ok(browserMeasurement.count > 2, "browser transition paints intermediate frames");
      const imageFlight = browserMeasurement.middle;
      assert.ok(
        imageFlight.rect && imageFlight.rect.x >= -1 && imageFlight.rect.x + imageFlight.rect.width <= 391,
        "browser expands within visible scene " + JSON.stringify(imageFlight),
      );
      const fades = imageFlight.fades;
      if (process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER)
        assert.ok(
          Math.abs(fades.card - fades.live) < 0.05,
          "top-layer sibling opacity follows its card " + JSON.stringify(fades),
        );
      await page.screenshot({ path: output + "/browser-exiting-" + fromChat + ".png" });
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      await assertSettledScene("[data-browser-scene]");
    }
    // Readiness is independent of animation duration. Hold the real renderer
    // acknowledgement, then cancel and deliver its obsolete completion.
    await page.evaluate(() => (window as any).fixture.panels.open("scope", "terminal", { id: "ready-origin" }));
    await page.waitForTimeout(550);
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.getByTestId("composer-panel-toggle").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const committedBeforePreparation = await page.evaluate(
      () => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId,
    );
    await page.evaluate(() => ((window as any).holdBrowserPresentation = true));
    await page.locator('.panel-overview-card[data-tab-kind="browser"] .ui-object-title-button').click();
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=preparing]"));
    const frozenSrc = await page
      .locator('.panel-overview-card[data-tab-kind="browser"] .panel-overview-card__preview img')
      .getAttribute("src");
    await page.evaluate(() => {
      const nav = (window as any).browserNavigation;
      const tab = nav.tabs.find((t) => t.kind === "browser");
      (window as any).previewColor = "#dc7030";
      nav.previews.refresh(tab);
      nav.previews.request(tab, nav.renderers.find((r) => r.kind === "browser").preview);
    });
    await page.waitForFunction((src) => {
      const nav = (window as any).browserNavigation;
      return nav.previews.get(nav.tabs.find((t) => t.kind === "browser"))?.src !== src;
    }, frozenSrc);
    assert.equal(
      await page
        .locator('.panel-overview-card[data-tab-kind="browser"] .panel-overview-card__preview img')
        .getAttribute("src"),
      frozenSrc,
      "resource refresh must not replace a leased transition frame",
    );
    await page.waitForTimeout(650);
    assert.equal((await sample()).phase, "preparing", "elapsed spring duration cannot uncover an unready destination");
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").foreground),
      "primary",
      "preparation must not write owner navigation",
    );
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId),
      committedBeforePreparation,
      "preparation cannot commit the selected tab",
    );
    assert.equal(
      await page.evaluate(() =>
        Number(getComputedStyle(document.querySelector(".panel-mobile-sheet--tabs")!, "::before").opacity),
      ),
      1,
      "preparation keeps the overview cover",
    );
    await page.evaluate(() => (window as any).overview.preparedScene?.cancel());
    await page.evaluate(() => (window as any).releaseBrowserPresentation?.());
    await page.waitForTimeout(80);
    assert.equal(
      await page.getByRole("dialog").count(),
      1,
      "late readiness cannot close the overview after cancellation",
    );
    assert.equal(
      await page.evaluate(() => (window as any).scene.contentPresentation),
      "primary",
      "cancel restores the original scene intent",
    );
    await page.locator('.panel-overview-card[data-tab-kind="browser"] .ui-object-title-button').click();
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=preparing]"));
    await page.evaluate(() => {
      (window as any).holdBrowserPresentation = false;
      (window as any).releaseBrowserPresentation?.();
    });
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=exiting]"));
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await assertSettledScene("[data-browser-scene]");
    // A partly visible card has a smaller aperture than its full layout box.
    // The moving view must converge to that aperture before handback, including
    // native top-layer paint that does not inherit the frame's CSS clipping.
    await page.evaluate(() => (window as any).fixture.panels.open("scope", "terminal", { id: "clipped-terminal" }));
    await page.waitForTimeout(550);
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const clipped = page.locator('.panel-overview-card[data-tab-id="clipped-terminal"]');
    await clipped.evaluate((card) => {
      const scroll = card.closest(".panel-overview__scroll") as HTMLElement;
      scroll.style.height = "380px";
      scroll.style.flex = "none";
      const target = card.querySelector(".panel-overview-card__preview")!;
      scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().bottom + 45;
    });
    await page.waitForTimeout(60);
    const clipBox = await clipped.locator("[data-overview-view]").boundingBox();
    const scrollBox = await page.locator(".panel-overview__scroll").boundingBox();
    assert.ok(
      clipBox &&
        scrollBox &&
        clipBox.y < scrollBox.y + scrollBox.height &&
        clipBox.y + clipBox.height > scrollBox.y + scrollBox.height,
      "fixture partially clips the card",
    );
    await page.evaluate(() => {
      const w = window as any;
      w.clipSamples = [];
      w.chromeSamples = [];
      w.stopClipCapture = false;
      const sample = () => {
        w.chromeSamples.push({
          open: !!document.querySelector(".panel-mobile-sheet--tabs"),
          opacity: Number(
            getComputedStyle(document.querySelector(".app-shell-root")!).getPropertyValue("--scene-chrome-opacity") ||
              1,
          ),
          header: Number(getComputedStyle(document.querySelector(".app-shell-header-motion-host > *")!).opacity),
          inert: (document.querySelector(".app-shell-header-motion-host > *") as HTMLElement).inert,
        });
        const frame = document.querySelector<HTMLElement>("[data-overview-flight]");
        if (frame) {
          const r = frame.getBoundingClientRect(),
            style = getComputedStyle(frame);
          const values = style.clipPath.match(/[-\d.]+/g)?.map(Number);
          w.clipSamples.push({
            phase: document.querySelector<HTMLElement>("[data-overview-phase]")?.dataset.overviewPhase,
            bottom: r.bottom - (values?.[2] ?? 0),
            clip: style.clipPath,
            overflow: style.overflow,
            radius: parseFloat(style.borderTopLeftRadius),
          });
        }
        if (!w.stopClipCapture) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const clipHit = await clipped.locator(".ui-object-title-button").boundingBox();
    assert.ok(clipHit);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: clipHit.x + clipHit.width / 2, y: clipHit.y + clipHit.height / 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=exiting]"));
    await page.waitForTimeout(80);
    await page.screenshot({ path: output + "/partial-card-flight.png" });
    await page.keyboard.press("Escape");
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector(".app-shell-root")!).getPropertyValue("--scene-chrome-opacity") || 1,
        ) > 0.99,
    );
    const clips = await page.evaluate(() => {
      (window as any).stopClipCapture = true;
      return (window as any).clipSamples;
    });
    assert.ok(
      clips.length > 2 &&
        clips.every(
          (f: any) => f.clip.startsWith("inset(") && Number.isFinite(f.radius) && /clip|hidden/.test(f.overflow),
        ),
      "every flying frame clips native content at its rounded border and decoration at the physical aperture",
    );
    await writeFile(output + "/clip-frames.json", JSON.stringify(clips, null, 2));
    assert.equal(
      await page.evaluate(() => (window as any).invalidSurface),
      undefined,
      "one travelling card contains its content throughout the flight",
    );
    const surfaceFrames = await page.evaluate(() => (window as any).surfaceFrames);
    assert.ok(
      surfaceFrames.every(
        (f: any) => f.headingOpacity <= 0.01 || (f.contentTop >= f.headingBottom - 1 && f.headingTop >= f.frameTop - 1),
      ),
      "visible heading ink fits its band without sharing content space",
    );
    assert.ok(
      surfaceFrames.filter((f: any) => f.radius === 0).every((f: any) => f.contentRadius === 0),
      "content corners reach the scene endpoint with the shell",
    );
    assert.ok(
      surfaceFrames.some((f: any) => f.raster && f.phase === "exiting" && f.frameOpacity > 0 && f.frameOpacity < 1),
      "raster cover dissolves into the drawable viewer",
    );
    assert.ok(
      surfaceFrames.filter((f: any) => f.raster && f.frameOpacity < 1).every((f: any) => f.radius < 0.01),
      "raster dissolves only after geometry reaches the scene endpoint",
    );
    assert.ok(
      surfaceFrames.some((f: any) => f.radius > 2 && f.headingOpacity > 0.1 && f.headingOpacity < 0.9),
      "title travels with geometry instead of waiting for a separate phase",
    );
    assert.ok(
      surfaceFrames.every((f: any) => f.headingClip === "none"),
      "titles are never revealed through a hard glyph clipping edge",
    );
    const chrome = await page.evaluate(() => (window as any).chromeSamples);
    await writeFile(output + "/chrome-frames.json", JSON.stringify(chrome));
    assert.ok(
      chrome.filter((f: any) => f.open).every((f: any) => f.opacity === 0 && f.header === 0),
      "scene chrome must not overlap overview controls during flight",
    );
    assert.ok(
      chrome.some((f: any) => !f.open && f.opacity > 0 && f.opacity < 1),
      "real controls reveal continuously after content handback",
    );
    assert.ok(
      chrome.filter((f: any) => f.opacity < 1).every((f: any) => f.inert),
      "fading chrome cannot accept pointer or keyboard input",
    );
    assert.equal(
      await page
        .locator(".app-shell-header-motion-host > *")
        .first()
        .evaluate((el: HTMLElement) => el.inert),
      false,
      "settled chrome regains input",
    );
    const reveal = chrome.filter((f: any) => !f.open);
    assert.ok(
      reveal.every((f: any, i: number) => i === 0 || f.opacity >= reveal[i - 1].opacity),
      "chrome reveal must not reverse or flash",
    );
    // Reduced motion and changing viewport settle the same navigation without stranded frames.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    assert.equal((await sample()).phase, undefined);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.setViewportSize({ width: 768, height: 900 });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-overview-flight]").count(), 0);
    // A newer selection revokes the previous completion, even for another card.
    await page.setViewportSize({ width: 390, height: 844 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.evaluate(() => {
      (window as any).fixture.panels.open("scope", "terminal", { id: "motion-second" });
    });
    await page.waitForTimeout(550);
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const terminalCards = page.locator('.panel-overview-card[data-tab-kind="terminal"]');
    const latestId = await terminalCards.nth(1).getAttribute("data-tab-id");
    await terminalCards.nth(0).scrollIntoViewIfNeeded();
    const switchFrame = await page.evaluate(async () => {
      const cards = document.querySelectorAll<HTMLElement>('.panel-overview-card[data-tab-kind="terminal"]');
      (window as any).pauseNextScene = true;
      cards[0].querySelector<HTMLButtonElement>(".ui-object-title-button")!.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const layout = document.querySelector<HTMLElement>(".panel-overview-layout")!;
      layout.style.setProperty("--height-tool-overview-card", "240px");
      layout.style.setProperty("--padding-tool-overview-card", "12px");
      window.visualViewport?.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const slot = document.querySelector<HTMLElement>("[data-overview-flight-slot]")!;
      const slotHeight = slot.getBoundingClientRect().height;
      const before = document.querySelector("[data-overview-flight]")?.getBoundingClientRect();
      (window as any).pauseNextScene = true;
      (window as any).pauseSceneTime = 0; // Freeze, do not seek the retiring flight before comparing continuity.
      cards[1].querySelector<HTMLButtonElement>(".ui-object-title-button")!.click();
      delete (window as any).pauseSceneTime;
      const after = document.querySelector("[data-overview-flight]")?.getBoundingClientRect();
      return {
        slotHeight,
        flights: document.querySelectorAll("[data-overview-flight]").length,
        before: before?.width,
        after: after?.width,
        activeCard: document.querySelector<HTMLElement>("[data-overview-flight]")?.dataset.tabId,
        originalCard: cards[0].dataset.tabId,
      };
    });
    console.log("replacement continuity", switchFrame);
    assert.ok(
      switchFrame.before &&
        switchFrame.after &&
        Math.abs(switchFrame.after - switchFrame.before) < 2 &&
        switchFrame.activeCard === switchFrame.originalCard,
      "resize then replacement preserves the actual painted frame without changing correction direction",
    );
    assert.equal(
      switchFrame.slotHeight,
      240,
      "the in-flow slot follows responsive card height rather than its initial pixels",
    );
    assert.equal(switchFrame.flights, 2, "latest card starts while the outgoing card returns; no serialized detour");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("[data-overview-flight], [data-overview-flight-slot]").count(),
      0,
      "both flight leases are released at handback",
    );
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId),
      latestId,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => (window as any).overview.chromeOpacity.get() === 1);
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await terminalCards.nth(0).scrollIntoViewIfNeeded();
    const reselected = await page.evaluate(async () => {
      const cards = document.querySelectorAll<HTMLElement>('.panel-overview-card[data-tab-kind="terminal"]');
      const choose = (index: number) =>
        cards[index].querySelector<HTMLButtonElement>(".ui-object-title-button")!.click();
      (window as any).pauseNextScene = true;
      choose(0);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      choose(1);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const before = cards[0].getBoundingClientRect();
      choose(0);
      const after = cards[0].getBoundingClientRect();
      return { id: cards[0].dataset.tabId, before: before.width, after: after.width };
    });
    assert.ok(
      Math.abs(reselected.before - reselected.after) < 2,
      "A→B→A adopts the returning card without a geometric jump",
    );
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId),
      reselected.id,
    );
    assert.equal(await page.locator("[data-overview-flight], [data-overview-flight-slot]").count(), 0);
    // Wide touch layout uses the actual pane, and keeps the same single overview.
    await page.setViewportSize({ width: 1024, height: 900 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      if (p.getOwnerSnapshot("scope").rightPanelFullWidth) p.dispatch("scope", { type: "toggle-right-full-width" });
      (window as any).fixture.setThemePreference("dark");
    });
    await page.waitForTimeout(550);
    const opener = page.locator(".panel-toolbar-overview:visible, .panel-mobile-dock__tabs:visible").first();
    await opener.click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    assert.equal(await page.getByRole("dialog").count(), 1);
    await page.getByRole("button", { name: "Main chat", exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=exiting]"));
    const wide = await sample();
    assert.ok(wide.rect && wide.rect.width < 1024, "wide layout expands within a pane");
    await page.screenshot({ path: output + "/wide-dark-exiting.png" });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as any).fixture.chatMounts()), 1);
    assert.deepEqual(errors, []);
    await writeFile(
      output + "/motion.json",
      JSON.stringify(
        { enteringStart, enteringMiddle, exitingStart, exitingMiddle, beforeReverse, afterReverse },
        null,
        2,
      ),
    );
    // A -> B -> A restores primary even though the terminal remains selected.
    await page.evaluate(() => {
      const w = window as any;
      w.scene.selectPrimary();
      w.fixture.panels.open("other", "terminal", { id: "other-terminal" });
      w.setFixtureOwner("other");
    });
    await page.waitForFunction(() => (window as any).scene.sceneOwnerId === "other");
    await page.evaluate(() => (window as any).setFixtureOwner("scope"));
    await page.waitForFunction(() => (window as any).scene.sceneOwnerId === "scope");
    assert.equal(await page.evaluate(() => (window as any).scene.foreground), "primary");
    await page.locator("[data-wide-primary] button").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    assert.equal(
      await page.evaluate(() => (window as any).overview.origin.key),
      JSON.stringify(["primary-chat", "scope"]),
      "split composer originates from primary",
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.locator("[data-wide-primary] button").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.evaluate(() => ((window as any).holdBrowserPresentation = true));
    await page.locator('.panel-overview-card[data-tab-kind="browser"] .ui-object-title-button').click();
    await page.waitForFunction(() => !!document.querySelector("[data-overview-phase=preparing]"));
    await page.evaluate(() => {
      const w = window as any;
      w.obsoleteReady = w.releaseBrowserPresentation;
      w.setFixtureOwner("other");
    });
    await page.waitForFunction(() => (window as any).scene.sceneOwnerId === "other");
    await page.evaluate(() => {
      const w = window as any;
      w.obsoleteReady?.();
      w.holdBrowserPresentation = false;
      w.setFixtureOwner("scope");
    });
    await page.waitForFunction(() => (window as any).scene.sceneOwnerId === "scope");
    assert.equal(
      await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").foreground),
      "primary",
      "retired preparation cannot change owner navigation",
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator("[data-overview-flight]").count(), 0);
    // Replacing the panel owner is one React batch: the destination need not
    // pass through null. A stale request must never strand invisible chrome.
    await opener.click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.evaluate(() => {
      const o = (window as any).overview;
      const old = o.destination;
      (window as any).oldDestination = old;
      o.release(old.token);
      o.publish({ ...old, token: Symbol("replacement"), ownerId: "replacement" });
    });
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.waitForTimeout(50);
    assert.equal(
      await page.evaluate(() => (window as any).overview.chromeOpacity.get()),
      1,
      "owner replacement must restore Shell chrome before paint",
    );
    await page.evaluate(() => (window as any).overview.publish((window as any).oldDestination));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      for (const t of p.getOwnerSnapshot("scope").right.tabs) p.close("scope", "right", t.id);
      p.open("scope", "terminal", { id: "last-tool" });
    });
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.getByRole("dialog").waitFor();
    await page.evaluate(() => (window as any).fixture.panels.close("scope", "right", "last-tool"));
    await page.locator(".panel-overview-inline").waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.ok(
      !(await page.locator(".panel-overview-inline .retained-view-preview").innerText()).includes(
        "Return to the conversation",
      ),
      "closing the last tool hands the live chat preview back to the inline overview",
    );
    assert.equal(
      await page.locator('[data-retained-view="primary-chat"][data-retained-preview="true"]').count(),
      1,
      "exactly one overview borrows the primary chat",
    );
    // A selected type filter remains operable when closing a tab crosses the
    // threshold used to initially expose the filter controls.
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      for (let i = 0; i < 6; i++) p.open("scope", "terminal", { id: "filter-" + i });
      p.open("scope", "browser", {});
    });
    await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
    await page.getByRole("button", { name: "Terminals", exact: true }).click();
    await page.evaluate(() => (window as any).fixture.panels.close("scope", "right", "filter-0"));
    assert.equal(
      await page.getByRole("button", { name: "All", exact: true }).isVisible(),
      true,
      "closing a tab must not hide the active filter and trap other tab kinds",
    );
    await page.getByRole("button", { name: "All", exact: true }).click();
    assert.equal(
      await page.locator('.panel-mobile-sheet--tabs .panel-overview-card[data-tab-kind="browser"]').count(),
      1,
    );
    await page.evaluate(() => {
      const p = (window as any).fixture.panels;
      for (const t of p.getOwnerSnapshot("scope").right.tabs) p.close("scope", "right", t.id);
    });
    assert.equal(await page.getByRole("dialog").getByRole("searchbox").count(), 0);
    assert.equal(await page.getByRole("dialog").getByText("No matching tabs", { exact: true }).count(), 0);
    await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
    const surfaces = await page.evaluate(() => {
      (window as any).stopSurfaceCapture = true;
      return (window as any).surfaceFrames;
    });
    await writeFile(output + "/surface-frames.json", JSON.stringify(surfaces, null, 2));
    assert.ok(surfaces.length > 10);
    assert.ok(
      surfaces.every(
        (s: any) => s.radius >= 0 && s.backdrop >= 0 && s.backdrop <= 1 && Math.abs(s.backdrop - s.scrim) < 0.01,
      ),
      "radius, backdrop and scrim share bounded scene progress",
    );
    assert.ok(
      surfaces.filter((s: any) => s.fullscreen).every((s: any) => s.scrimPaint === "rgba(0, 0, 0, 0)"),
      "fullscreen overview must not expose a second black backdrop while its canvas fades",
    );
    for (const phase of ["entering", "exiting"])
      assert.ok(
        surfaces.some(
          (s: any) => s.phase === phase && s.backdrop > 0.1 && s.backdrop < 0.9 && s.background === "rgba(0, 0, 0, 0)",
        ),
        "backdrop interpolates during " + phase,
      );
    console.log(
      "PASS overview motion: bidirectional geometry, reversal, DOM/iframe/draft/terminal retention, reduced motion, resize",
    );
  } else {
    // Cold empty entry must work before the lazy mobile toolbar has ever loaded.
    await page.locator(".panel-overview-inline").waitFor();
    if (process.env.OPENCRAFT_PREVIEW_FORCE_LEGACY) {
      assert.equal(
        await page.locator(".panel-overview-primary .retained-view-preview").innerText(),
        "Return to the conversation",
      );
      assert.equal(
        await page.locator("[data-retained-view=primary-chat][data-retained-preview=true]").count(),
        0,
        "legacy engine leaves embedded browsing contexts in place",
      );
      await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.marker === 1);
      await page.locator("iframe").evaluate((e) => {
        (e as HTMLIFrameElement).contentWindow!.marker = 87;
      });
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      assert.equal(await page.locator("iframe").evaluate((e) => (e as HTMLIFrameElement).contentWindow!.marker), 87);
      await page.evaluate(() => {
        const p = (window as any).fixture.panels;
        p.open("scope", "terminal", { id: "legacy" });
        p.dispatch("scope", { type: "set-region-open", region: "right", open: true });
      });
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.locator("[data-retained-view=panel][data-retained-preview=true] .xterm").waitFor();
      assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), 1);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), 1);
      assert.equal(await page.locator("iframe").evaluate((e) => (e as HTMLIFrameElement).contentWindow!.marker), 87);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ ok: true, legacy: true, framePreserved: true, terminalReused: true, output }));
    } else {
      assert.equal(
        await page.locator(".right-panel-toolbar").count(),
        0,
        "touch overview does not mount the desktop creation menu",
      );
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-layout-inset-bottom", "34px");
        document.documentElement.style.setProperty("--safe-layout-inset-top", "20px");
      });
      for (const [palette, mode] of [
        ["longingThemePalette", "light"],
        ["longingThemePalette", "dark"],
        ["lavenderThemePalette", "light"],
      ]) {
        await page.evaluate(([palette, mode]) => (window as any).fixture.paletteTheme(palette, mode), [palette, mode]);
        await page.waitForTimeout(150);
        const paints = await page.evaluate(() => {
          const read = (selector: string) => {
            const s = getComputedStyle(document.querySelector(selector)!);
            return { color: s.backgroundColor, image: s.backgroundImage };
          };
          return {
            row: read(".app-shell-row"),
            inline: read(".panel-overview-inline"),
            view: read(".right-panel-view"),
            chassis: read(".app-shell-right-panel__clip"),
            header: read(".app-shell-header"),
            safeBottom: getComputedStyle(document.querySelector(".app-shell-row")!).paddingBottom,
          };
        });
        for (const surface of ["inline", "view", "chassis", "header"] as const)
          assert.deepEqual(
            paints[surface],
            { color: "rgba(0, 0, 0, 0)", image: "none" },
            surface + " must let the single Shell canvas show through",
          );
        assert.notEqual(paints.row.color, "rgba(0, 0, 0, 0)");
        assert.equal(paints.safeBottom, "34px");
        await page.screenshot({ path: output + "/cold-" + palette + "-" + mode + ".png" });
      }
      const inlineDone = await page.getByRole("button", { name: "Done", exact: true }).boundingBox();
      assert.ok(inlineDone);
      assert.ok(
        Math.abs(inlineDone.y + inlineDone.height - (844 - 34 - 16)) < 2,
        "empty inline overview anchors Done to the protected bottom",
      );
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.marker === 1);
      await page.locator("iframe").evaluate((e) => {
        (e as HTMLIFrameElement).contentWindow!.marker = 87;
      });
      const initialFrameLoads = await page.evaluate(() => (window as any).fixture.frameLoads());
      await page.getByTestId("composer-panel-toggle").click();
      await page.locator(".panel-mobile-sheet--tabs").waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1, "main chat and tools share one overview");
      const modalDone = await page.getByRole("button", { name: "Done", exact: true }).boundingBox();
      assert.ok(modalDone);
      assert.ok(
        Math.abs(modalDone.y - inlineDone.y) < 2 && Math.abs(modalDone.x - inlineDone.x) < 2,
        "inline and modal share the Done anchor " + JSON.stringify({ inlineDone, modalDone }),
      );
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert.equal(
        await page.evaluate(() => (window as any).scene.contentPresentation),
        "primary",
        "dismiss preserves main chat as destination",
      );
      assert.equal(
        await page
          .locator(".app-shell-root")
          .evaluate((e) => getComputedStyle(e).getPropertyValue("--app-shell-page-paint").trim()),
        "",
        "hidden retained overview must release Shell paint",
      );
      await page.evaluate(() => {
        const p = (window as any).fixture.panels;
        for (let i = 0; i < 4; i++) p.open("scope", "terminal", { id: String(i) });
        for (const kind of ["browser", "resource", "custom"]) p.open("scope", kind, {});
        document.documentElement.style.removeProperty("--safe-layout-inset-bottom");
        document.documentElement.style.removeProperty("--safe-layout-inset-top");
        (window as any).fixture.setThemePreference("light");
      });
      await page.waitForTimeout(500);
      if (!(await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.open)))
        await page.locator("button.app-shell-header__right-panel-toggle").click();
      await page.locator(".panel-mobile-dock__tabs").waitFor();
      await page.screenshot({ path: output + "/before.png" });
      const hit = await page.locator(".panel-mobile-dock__tabs").boundingBox();
      assert.ok(hit);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.locator(".panel-overview__grid").waitFor();
      assert.equal(await page.locator(".panel-overview-card[data-tab-id]").count(), 7);
      const manyDone = await page.getByRole("button", { name: "Done", exact: true }).boundingBox();
      assert.ok(manyDone && hit);
      assert.ok(
        Math.abs(manyDone.x - hit.x) < 2 &&
          Math.abs(manyDone.y - hit.y) < 2 &&
          Math.abs(manyDone.width - hit.width) < 2 &&
          Math.abs(manyDone.height - hit.height) < 2,
        "overview Done preserves the tool navigation hit target",
      );
      await page.locator(".panel-overview__scroll").evaluate((e) => (e.scrollTop = e.scrollHeight));
      assert.deepEqual(
        await page.getByRole("button", { name: "Done", exact: true }).boundingBox(),
        manyDone,
        "scrolling cards cannot move Done",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.classList.contains("panel-mobile-sheet--tabs")),
        true,
        "opening focuses the modal, not search",
      );
      assert.equal(await page.locator(".panel-overview__header").count(), 0, "no visible title");
      assert.equal(
        await page
          .locator(".panel-overview-card[data-active=true] .panel-overview-card__preview")
          .evaluate((e) => getComputedStyle(e).outlineStyle),
        "none",
        "selection is not a blue focus outline",
      );
      assert.equal(await page.getByRole("dialog").getByRole("searchbox").count(), 0, "overview has no search field");
      await page.keyboard.press("Tab");
      assert.equal(
        await page.getByRole("button", { name: "All", exact: true }).evaluate((e) => e === document.activeElement),
        true,
        "type filters remain keyboard reachable",
      );
      await page.getByRole("button", { name: "Terminals", exact: true }).click();
      assert.equal(await page.locator(".panel-overview-card[data-tab-id]").count(), 4);
      await page
        .locator(".retained-preview-view[data-retained-view=panel][data-retained-preview=true] .xterm")
        .first()
        .waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector(".retained-preview-view[data-retained-view=panel][data-retained-preview=true] .xterm-rows")
          ?.textContent?.includes("build complete"),
      );
      assert.equal(
        (
          await page
            .locator(".retained-preview-view[data-retained-view=panel][data-retained-preview=true] .xterm-rows")
            .first()
            .innerText()
        ).includes("x1b"),
        false,
        "native ANSI parser paints formatting rather than escape text",
      );
      const firstTerminal = page
        .locator(".retained-preview-view[data-retained-view=panel][data-retained-preview=true]")
        .first();
      assert.equal(
        await firstTerminal.locator("[data-native-terminal]").evaluate((e) => e.closest("[inert]") !== null),
        true,
      );
      assert.equal(
        await firstTerminal.locator(".xterm-helper-textarea").evaluate((e) => {
          (e as HTMLElement).focus();
          return e === document.activeElement;
        }),
        false,
        "native input cannot acquire focus inside the thumbnail",
      );
      const originalScreen = await firstTerminal.locator(".xterm-screen").evaluate((e) => {
        (window as any).originalScreen = e;
        return { width: (e as HTMLElement).clientWidth, height: (e as HTMLElement).clientHeight };
      });
      assert.ok(originalScreen.width > 300, "terminal keeps its original grid width");
      assert.equal(await page.evaluate(() => (window as any).fixture.terminals.get("0").cols), 80);
      assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), 4);
      await page.evaluate(() => (window as any).fixture.setPreview("A".repeat(200) + "\nupdated screen"));
      await page.waitForTimeout(150);
      await page.getByRole("button", { name: "All", exact: true }).click();
      const longTitle = page.locator(".panel-overview-card[data-tab-kind=browser] .panel-overview-card__title-scroll");
      assert.ok(await longTitle.evaluate((e) => e.scrollWidth > e.clientWidth));
      assert.equal(await longTitle.locator("button").evaluate((e) => getComputedStyle(e).whiteSpace), "nowrap");
      const headingHeights = await page
        .locator(".panel-overview-card[data-tab-id] .panel-overview-card__heading")
        .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
      assert.ok(
        headingHeights.every((h) => Math.abs(h - headingHeights[0]) < 1),
        "all tools retain equal heading height",
      );
      // A horizontal title drag must not activate the card; a later ordinary tap still can.
      await longTitle.dispatchEvent("pointerdown", { clientX: 100, clientY: 100 });
      await longTitle.dispatchEvent("pointermove", { clientX: 50, clientY: 100 });
      await longTitle.evaluate((e) => (e.scrollLeft = 40));
      await longTitle.locator("button").dispatchEvent("click", { detail: 1 });
      assert.equal(await page.locator(".panel-overview__grid").count(), 1);
      await longTitle.scrollIntoViewIfNeeded();
      await longTitle.evaluate((e) => (e.scrollLeft = 0));
      const titleHit = await longTitle.boundingBox();
      assert.ok(titleHit);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: titleHit.x + titleHit.width - 5, y: titleHit.y + titleHit.height / 2 }],
      });
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: titleHit.x + titleHit.width - 5 - i * 8, y: titleHit.y + titleHit.height / 2 }],
        });
        await page.waitForTimeout(20);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(100);
      assert.ok((await longTitle.evaluate((e) => e.scrollLeft)) > 0, "touch drag scrolls the single-line title");
      assert.equal(await page.locator(".panel-overview__grid").count(), 1, "title swipe does not open the tool");
      await page.locator(".panel-overview__filters").getByRole("button", { name: "Files", exact: true }).click();
      assert.equal(
        await page.locator("[data-native-terminal][data-input-active=true]").count(),
        0,
        "filtering does not reactivate parked terminals",
      );
      assert.equal(
        await page.locator(".retained-preview-view[data-retained-view=primary-chat]").evaluate((e) => e.inert),
        true,
        "chat remains readonly while filtering",
      );
      assert.equal(await page.locator(".panel-overview-card[data-tab-id]").count(), 1);
      if (presentation) {
        assert.equal(
          await page.locator(".panel-overview-card__preview img").getAttribute("src"),
          presentation.thumbnail,
        );
        await page.screenshot({ path: output + "/remote-presentation.png" });
      }
      await page.getByRole("button", { name: "All", exact: true }).click();
      await page.locator(".panel-overview__scroll").evaluate((e) => (e.scrollTop = 0));
      await page.waitForTimeout(200);
      await page.evaluate(() => (window as any).fixture.setPreview("$ node -v\nv22.0.0\n$ npm run dev\n✓ ready\n$ "));
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() => (window as any).fixture.previewCalls()),
        0,
        "native viewer is reused without text extraction",
      );
      assert.equal(
        await page
          .locator(
            ".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true] [data-real-chat]",
          )
          .count(),
        1,
        "main card borrows the real chat node",
      );
      assert.equal(await page.evaluate(() => (window as any).fixture.chatMounts()), 1);
      assert.equal(
        await page.locator("iframe").evaluate((e) => (e as HTMLIFrameElement).contentWindow!.marker),
        87,
        "embedded browsing context survives preview placement",
      );
      assert.equal(await page.evaluate(() => (window as any).fixture.frameLoads()), initialFrameLoads);
      assert.equal(
        await page
          .locator(".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true]")
          .evaluate((e) => e.inert),
        true,
      );
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), theme);
        await page.waitForTimeout(200);
        await page.screenshot({ path: output + "/" + theme + ".png" });
        const bounds = await page.locator(".panel-overview__footer").boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 844);
      }
      await page.evaluate(() => (window as any).fixture.customTheme());
      await page.screenshot({ path: output + "/custom-theme.png" });
      assert.equal(await page.locator(".panel-overview-primary").count(), 1);
      assert.equal(await page.locator(".panel-overview-create").count(), 1);
      assert.equal(
        await page.locator(".panel-overview-create__actions").evaluate((e) => e.scrollHeight > e.clientHeight),
        true,
        "extra creation types scroll inside the card",
      );
      await page.locator(".panel-overview-create__actions").scrollIntoViewIfNeeded();
      const outerBefore = await page.locator(".panel-overview__scroll").evaluate((e) => e.scrollTop);
      // A prior horizontal touch must not lock the axis of a subsequent mouse wheel.
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.locator(".panel-overview-create__actions").hover();
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(250);
      assert.ok(
        (await page.locator(".panel-overview-create__actions").evaluate((e) => e.scrollTop)) > 0,
        "wheel uses its own axis after a horizontal touch gesture",
      );
      await page.locator(".panel-overview-create__actions").evaluate((e) => (e.scrollTop = 0));
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const createHit = await page.locator(".panel-overview-create__actions").boundingBox();
      assert.ok(createHit);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: createHit.x + createHit.width / 2, y: createHit.y + createHit.height - 15 }],
      });
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: createHit.x + createHit.width / 2, y: createHit.y + createHit.height - 15 - i * 10 }],
        });
        await page.waitForTimeout(40);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(250);
      assert.ok(
        (await page.locator(".panel-overview-create__actions").evaluate((e) => e.scrollTop)) > 0,
        "creation card accepts vertical touch scrolling",
      );
      assert.equal(
        await page.locator(".panel-overview__grid").count(),
        1,
        "scrolling creation actions does not create a tool",
      );
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.locator(".panel-overview-create__actions").evaluate((e) => (e.scrollTop = 0));
      await page.locator(".panel-overview-create__actions").hover();
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(250);
      assert.ok((await page.locator(".panel-overview-create__actions").evaluate((e) => e.scrollTop)) > 0);
      assert.equal(
        await page.locator(".panel-overview__scroll").evaluate((e) => e.scrollTop),
        outerBefore,
        "inner scrolling does not move the overview until its boundary",
      );
      await page.locator(".panel-overview-create__actions").evaluate((e) => (e.scrollTop = 0));
      assert.equal(await page.locator(".panel-overview-primary").getByRole("button").count(), 1);
      await page.screenshot({ path: output + "/create.png" });
      await page.getByRole("button", { name: "Terminal 0", exact: true }).click();
      assert.equal(
        await page
          .locator(".right-panel-view .xterm-screen")
          .first()
          .evaluate((e) => e === (window as any).originalScreen),
        true,
      );
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert.equal(await page.locator("[data-retained-preview=true]").count(), 0, "closing restores every native view");
      assert.equal(await page.evaluate(() => (window as any).fixture.terminalMounts()), 4);
      assert.equal(await page.evaluate(() => (window as any).fixture.terminals.get("0").cols), 80);
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.getByRole("button", { name: "Close Terminal 1", exact: true }).click();
      assert.equal(await page.locator(".panel-overview-card[data-tab-id]").count(), 6);
      await page.locator(".panel-overview-create").getByRole("button", { name: "New terminal", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".panel-overview__grid"));
      assert.equal(
        await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.tabs.length),
        7,
      );
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      await page.getByTestId("composer-panel-toggle").click();
      await page.getByRole("button", { name: "Terminal 0", exact: true }).click();
      assert.equal(
        await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.open),
        true,
        "selecting a tool from main chat reveals it",
      );
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Draft", exact: true }).fill("Main draft stays");
      await page.locator("[data-real-chat]").evaluate((e) => {
        e.scrollTop = 400;
        (window as any).originalScroll = e.scrollTop;
        (window as any).originalChat = e;
        (window as any).originalChatWidth = (e as HTMLElement).clientWidth;
      });
      await page.locator("button.app-shell-header__right-panel-toggle").click();
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      assert.equal(
        await page
          .locator(
            ".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true] [data-real-chat]",
          )
          .evaluate((e) => e === (window as any).originalChat),
        true,
        "overview presents the same chat DOM",
      );
      assert.equal(
        await page
          .locator(
            ".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true] [data-real-chat]",
          )
          .evaluate((e) => (e as HTMLElement).clientWidth === (window as any).originalChatWidth),
        true,
        "thumbnail preserves original layout width",
      );
      assert.ok((await page.evaluate(() => (window as any).originalScroll)) > 0);
      assert.equal(
        await page
          .locator(
            ".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true] [data-real-chat]",
          )
          .evaluate((e) => e.scrollTop === (window as any).originalScroll),
        true,
      );
      const nativeHeight = await page
        .locator(".retained-preview-view[data-retained-view=primary-chat][data-retained-preview=true] h2")
        .evaluate((e) => ({ logical: (e as HTMLElement).offsetHeight, measured: (window as any).fixture.measure(e) }));
      assert.ok(
        Math.abs(nativeHeight.logical - nativeHeight.measured) < 1,
        "initial timeline measurements compensate visual scale",
      );
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "Draft", exact: true }).inputValue(), "Main draft stays");
      assert.equal(
        await page.locator("[data-real-chat]").evaluate((e) => e.scrollTop === (window as any).originalScroll),
        true,
      );
      assert.equal(await page.evaluate(() => (window as any).fixture.chatMounts()), 1);
      await page.evaluate(() => {
        const p = (window as any).fixture.panels;
        for (const t of p.getOwnerSnapshot("scope").right.tabs) p.close("scope", "right", t.id);
      });
      await page.locator("button.app-shell-header__right-panel-toggle").click();
      await page.locator(".panel-overview-inline").waitFor();
      assert.equal(await page.getByRole("searchbox").count(), 0);
      assert.equal(await page.locator(".panel-overview-card").count(), 2);
      assert.equal(await page.locator(".panel-overview__count").count(), 0);
      await page.screenshot({ path: output + "/empty.png" });
      await page.locator(".panel-overview-create").getByRole("button", { name: "New terminal", exact: true }).click();
      await page.locator(".panel-mobile-dock__tabs").waitFor();
      // Real Shell transition coverage: compact/tablet use the same intent and retained resources.
      const resizeScene = async (width: number) => {
        await page.setViewportSize({ width, height: 900 });
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: true,
        });
        await page.waitForTimeout(450);
      };
      await page.evaluate(() => {
        const p = (window as any).fixture.panels;
        if (p.getOwnerSnapshot("scope").rightPanelFullWidth) p.dispatch("scope", { type: "toggle-right-full-width" });
        (window as any).scene.selectTools();
      });
      const toolBefore = await page.evaluate(
        () => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId,
      );
      for (const width of [768, 799, 1024, 390]) {
        await resizeScene(width);
        assert.equal(
          await page.evaluate(() => (window as any).scene.contentPresentation),
          width >= 800 ? "split" : "tools",
        );
        assert.equal(
          await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.activeTabId),
          toolBefore,
        );
      }
      await page.locator(".panel-mobile-dock [data-app-shell-sidebar-trigger]").click();
      assert.equal(await page.evaluate(() => (window as any).scene.sidebarOpen), true);
      assert.equal(await page.evaluate(() => (window as any).scene.contentPresentation), "tools");
      await resizeScene(1024);
      assert.equal(
        await page.evaluate(() => (window as any).scene.sidebarFloating),
        true,
        "resize does not pin a transient drawer",
      );
      await page.evaluate(() => (window as any).scene.toggleSidebar());
      await resizeScene(390);
      assert.equal(await page.evaluate(() => (window as any).scene.contentPresentation), "tools");
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.locator(".panel-overview__grid").evaluate((e) => ((window as any).originalOverviewGrid = e));
      await resizeScene(1024);
      assert.equal(
        await page.locator(".panel-overview__grid").evaluate((e) => e === (window as any).originalOverviewGrid),
        true,
        "overview content DOM survives resizing",
      );
      assert.equal(await page.getByRole("dialog").getByRole("searchbox").count(), 0);
      assert.equal(await page.getByRole("dialog").getAttribute("data-presentation"), "adaptive-sheet");
      await page.screenshot({ path: output + "/ipad-overview.png" });
      await page.getByRole("button", { name: "Main chat", exact: true }).click();
      assert.equal(await page.evaluate(() => (window as any).scene.contentPresentation), "split");
      await page.screenshot({ path: output + "/ipad-split.png" });
      assert.equal(
        await page.evaluate(() => (window as any).fixture.panels.getOwnerSnapshot("scope").right.open),
        true,
        "selecting primary never closes tools",
      );
      await resizeScene(390);
      assert.equal(await page.evaluate(() => (window as any).scene.contentPresentation), "primary");
      await page.getByTestId("composer-panel-toggle").click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.evaluate(() => {
        (window as any).scene.selectPrimary();
      });
      await page.evaluate(() => (window as any).fixture.panels.open("scope", "browser", {}));
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => (window as any).scene.contentPresentation),
        "tools",
        "external explicit resource open reveals its viewer",
      );
      await page.evaluate(
        (tabId) => (window as any).fixture.panels.dispatch("scope", { type: "activate-tab", region: "right", tabId }),
        toolBefore,
      );
      await resizeScene(1024);
      await page.evaluate(() => (window as any).scene.selectPrimary());
      await page.locator('.right-panel-tab__activate[aria-selected="true"]').click();
      await resizeScene(390);
      assert.equal(
        await page.evaluate(() => (window as any).scene.contentPresentation),
        "tools",
        "explicit wide tab activation becomes compact foreground",
      );
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.locator(".panel-mobile-dock__tabs").click({ noWaitAfter: true });
      await page.setViewportSize({ width: 700, height: 900 });
      await page.screenshot({ path: output + "/wide.png" });
      await page.keyboard.press("Escape");
      await page.evaluate(() => (document.documentElement.dataset.uiDensity = "compact"));
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".right-panel-toolbar").count(), 1, "desktop toolbar remains available");
      await page.locator(".right-panel-toolbar").getByRole("button", { name: "Tabs", exact: true }).click();
      assert.ok((await page.getByRole("menuitem").count()) > 0);
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          ok: true,
          search: false,
          dynamicKinds: true,
          previews: true,
          themes: ["light", "dark", "lavender"],
          retainedDraft: true,
          close: true,
          create: true,
          touch: true,
          keyboard: true,
          output,
        }),
      );
    }
  }
} catch (error) {
  console.error("SMOKE_FAILURE", error);
  if (browser) {
    const p = await browser.firstWindow();
    console.error(
      "SCENE",
      await p.evaluate(() => ({
        scene: (window as any).scene,
        panel: (window as any).fixture?.panels.getOwnerSnapshot("scope"),
        rects: [...document.querySelectorAll(".app-shell-right-panel,.panel-overview-inline,.right-panel-content")].map(
          (e) => ({
            cls: e.className,
            rect: e.getBoundingClientRect().toJSON(),
            attrs: e.getAttributeNames().map((a) => [a, e.getAttribute(a)]),
          }),
        ),
      })),
    );
    console.error("FAILED_BODY", await p.locator("body").innerText());
    await p.screenshot({ path: output + "/failed.png", timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
}
