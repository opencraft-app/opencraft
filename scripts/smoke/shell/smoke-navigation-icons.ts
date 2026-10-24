import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp(join(tmpdir(), "opencraft-navigation-icons-"));
const source = `
import React,{useState}from'react';
import{motion,useMotionValue}from'motion/react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{ShellNavigationDock}from'/apps/workbench-web/src/components/shell-navigation/index.tsx';
import{createShellNavigationState,projectShellNavigation}from'@opencraft/workbench-runtime';
import{bindTouchInteractionMode}from'/apps/workbench-web/src/runtime/pointer-modality.ts';
import{buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,lavenderThemePalette}from'@opencraft/design-system/theme-engine';
import'/apps/workbench-web/src/styles/app.scss';
bindTouchInteractionMode(document);
function App(){const[compact,setCompact]=useState(true),[active,setActive]=useState('chat');
const expanded=useMotionValue(137),frame=useMotionValue(52);
const state=createShellNavigationState({applications:true,railDetent:compact?'compact':'expanded'});
const projection=projectShellNavigation({state,viewportWidth:1200,contextWidth:275,contextAvailable:true,sidecarOpen:true});
const actions=['chat','message-circle','folder','cloud','bot','server'].map(name=>({id:name,title:name,icon:name,active:active===name,onInvoke:()=>setActive(name)}));
window.fixture={active:()=>active,resize:v=>frame.set(v),compact:v=>{frame.set(v?52:137);setCompact(v)},theme:(mode,family)=>{
document.documentElement.dataset.theme=mode;const palette=(family==='lavender'?lavenderThemePalette:opencraftNeutralThemePalette)[mode];
for(const[key,value]of Object.entries(buildOpenCraftThemeCssProperties(mode,palette)))document.documentElement.style.setProperty(key,value);
}};
return <main style={{display:'flex',padding:24,gap:36,background:'var(--color-background-surface)',color:'var(--color-text)'}}>
<motion.div className='shell-navigation__dock' style={{width:frame,height:650}}>
<ShellNavigationDock controller={{state,projection}} expandedWidth={expanded} frameWidth={frame}
config={{actions,account:null,onOpenSettings:()=>setActive('settings'),settingsActive:active==='settings'}}/></motion.div>
<section><h1>Navigation</h1><p>Shared navigation state and geometry.</p><button className='shell-sign-in-menu__item' id='menu'><svg width='15' height='15' viewBox='0 0 24 24'><path d='M4 12h16'/></svg>Menu density is unchanged</button></section>
</main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-navigation-icons",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "navigation-icons-fixture", resolveId: id => id === "/navigation-probe.tsx" ? id : null,
    load: id => id === "/navigation-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<html><head><title>Navigation glyph regression</title></head><body><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script></body></html>');
    }); },
  }],
});
let browser: any;
const errors: string[] = [], evidence: unknown[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 780 }, hasTouch: touch, isMobile: touch });
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const buttons = page.locator(".shell-navigation__items--applications > button");
    // This count is also a negative control: no Home or fabricated capability.
    await buttons.first().waitFor();
    assert.equal(await buttons.count(), 7);
    for (const family of ["neutral", "lavender"]) for (const mode of ["light", "dark"]) for (const compact of [true, false]) {
      await page.evaluate(({ mode, family, compact }: any) => {
        (window as any).fixture.theme(mode, family); (window as any).fixture.compact(compact);
      }, { mode, family, compact });
      const invoke = async (name: string) => {
        const button = buttons.filter({ hasText: name }).first();
        if (touch) await button.tap(); else await button.click();
      };
      await invoke("chat");
      const measurements = await buttons.evaluateAll((elements: HTMLElement[]) => elements.map(button => {
        const svg = button.querySelector("svg")!, b = button.getBoundingClientRect(), s = svg.getBoundingClientRect();
        return { label: button.textContent, buttonWidth: b.width, buttonHeight: b.height, svgWidth: s.width, svgHeight: s.height,
          contained: s.left >= b.left && s.right <= b.right && s.top >= b.top && s.bottom <= b.bottom,
          centered: Math.abs((s.top+s.bottom)-(b.top+b.bottom)) < .1,
          color: getComputedStyle(svg).color, buttonColor: getComputedStyle(button).color,
          selected: button.getAttribute("aria-current"), variant: svg.getAttribute("data-navigation-glyph-variant") };
      }));
      for (const row of measurements) {
        assert.equal(row.svgWidth, 14, JSON.stringify(row)); assert.equal(row.svgHeight, 14);
        assert.equal(row.contained, true); assert.equal(row.centered, true);
        assert.equal(row.color, row.buttonColor, "glyph inherits the navigation state, not menu secondary color");
        assert.ok(row.buttonHeight >= (touch ? 44 : 36));
        if (touch) assert.ok(row.buttonWidth >= 44);
      }
      assert.equal(measurements[0].selected, "page"); assert.equal(measurements[0].variant, "selected");
      assert.notEqual(measurements[0].color, measurements[1].color);
      assert.equal(await page.locator("#menu svg").evaluate((el: Element) => el.getBoundingClientRect().width), 14);
      await invoke("folder");
      assert.equal(await buttons.filter({ hasText: "chat" }).locator("svg").getAttribute("data-navigation-glyph-variant"), "outline");
      assert.equal(await buttons.filter({ hasText: "folder" }).locator("svg").getAttribute("data-navigation-glyph-variant"), "selected");
      assert.equal(await buttons.filter({ hasText: "folder" }).locator("svg").getAttribute("fill"), "none", "Core navigation keeps its line artwork family");
      const normalButton = buttons.filter({ hasText: "server" });
      const baseline = await normalButton.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
      await normalButton.hover();
      const hover = await normalButton.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
      assert.equal(hover === baseline, touch, "touch suppresses mouse-like hover; mouse retains it");
      await page.mouse.move(850, 700);
      await page.screenshot({ path: join(output, `${touch ? "touch" : "mouse"}-${family}-${mode}-${compact ? "compact" : "expanded"}.png`) });
      evidence.push({ touch, family, mode, compact, measurements });
    }
    // Exercise the real MotionValue geometry in both directions, not only its
    // endpoints. The action elements and focused control must retain identity.
    await buttons.first().focus();
    await buttons.first().evaluate((el: Element) => { (window as any).retainedNavigationButton = el; });
    for (const width of [52, 60, 80, 100, 137, 100, 80, 60, 52]) {
      await page.evaluate((width: number) => (window as any).fixture.resize(width), width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await buttons.evaluateAll((elements: HTMLElement[]) => elements.map(button => {
        const svg = button.querySelector("svg")!.getBoundingClientRect(), b = button.getBoundingClientRect();
        const frame = button.closest(".shell-navigation__dock")!.getBoundingClientRect();
        return { width: svg.width, height: svg.height, contained: svg.left >= b.left && svg.right <= b.right,
          buttonContained: b.left >= frame.left && b.right <= frame.right };
      }));
      assert.ok(geometry.every(row => row.width === 14 && row.height === 14 && row.contained && row.buttonContained), JSON.stringify({ touch, width, geometry }));
      assert.equal(await buttons.first().evaluate((el: Element) => el === (window as any).retainedNavigationButton && document.activeElement === el), true);
      evidence.push({ touch, resizeWidth: width, geometry });
    }
    await page.keyboard.press("Tab");
    const keyboardOutline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    assert.equal(keyboardOutline, "solid");
    await page.emulateMedia({ forcedColors: "active" });
    await buttons.first().focus();
    assert.equal(await buttons.first().evaluate((el: Element) => getComputedStyle(el).outlineStyle), "solid");
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, cases: evidence.length, output }));
} finally { await browser?.close(); await vite.close(); }
