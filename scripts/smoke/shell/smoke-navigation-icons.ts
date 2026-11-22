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
import{NavigationContent}from'/apps/workbench-web/src/components/shell-navigation/navigation-content.tsx';
import{ShellSidebarNavigation}from'/apps/workbench-web/src/components/shell-navigation/index.tsx';
import{bindTouchInteractionMode}from'/apps/workbench-web/src/runtime/pointer-modality.ts';
import{buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,lavenderThemePalette}from'@opencraft/design-system/theme-engine';
import'/apps/workbench-web/src/styles/app.scss';
bindTouchInteractionMode(document);
if (navigator.maxTouchPoints > 0) document.documentElement.dataset.uiDensity = "touch";
function App(){const[compact,setCompact]=useState(true),[active,setActive]=useState('chat');
const frame=useMotionValue(292);
const actions=['chat','message-circle','folder','cloud','bot','server'].map(name=>({id:name,title:name,icon:name,active:active===name,onInvoke:()=>setActive(name)}));
window.fixture={active:()=>active,resize:v=>frame.set(v),compact:v=>{frame.set(v?292:240);setCompact(v)},theme:(mode,family)=>{
document.documentElement.dataset.theme=mode;const palette=(family==='lavender'?lavenderThemePalette:opencraftNeutralThemePalette)[mode];
for(const[key,value]of Object.entries(buildOpenCraftThemeCssProperties(mode,palette)))document.documentElement.style.setProperty(key,value);
}};
return <main style={{display:'flex',padding:24,gap:36,background:'var(--color-background-surface)',color:'var(--color-text)'}}>
<motion.div className='navigation-fixture' style={{width:frame,height:650}}>
{compact
  ? <div className='shell-sidebar__column'><div className='shell-sidebar__navigation sidecar-content-slot'><ShellSidebarNavigation config={{actions,account:null,onOpenSettings:()=>setActive('settings')}} onInvoke={action=>action()}/></div></div>
  : <NavigationContent surface='applications' onInvoke={action=>action()} config={{actions,account:null,onOpenSettings:()=>setActive('settings'),settingsActive:active==='settings'}}/>
}</motion.div>
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
    assert.equal(await buttons.count(), 6);
    for (const family of ["neutral", "lavender"]) for (const mode of ["light", "dark"]) for (const compact of [true, false]) {
      await page.evaluate(({ mode, family, compact }: any) => {
        (window as any).fixture.theme(mode, family); (window as any).fixture.compact(compact);
      }, { mode, family, compact });
      const invoke = async (name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        if (touch) await button.tap(); else await button.click();
      };
      await invoke("chat");
      const measurements = await buttons.evaluateAll((elements: HTMLElement[]) => elements.map(button => {
        const svg = button.querySelector("svg")!, b = button.getBoundingClientRect(), s = svg.getBoundingClientRect();
        return { label: button.getAttribute("aria-label") ?? button.textContent, buttonWidth: b.width, buttonHeight: b.height, svgWidth: s.width, svgHeight: s.height,
          expectedSize: button.closest(".shell-sidebar__column")
            ? parseFloat(getComputedStyle(button).getPropertyValue("--size-application-navigation-icon"))
            : Number(svg.getAttribute("width")),
          contained: s.left >= b.left && s.right <= b.right && s.top >= b.top && s.bottom <= b.bottom,
          centered: Math.abs((s.top+s.bottom)-(b.top+b.bottom)) < .1,
          color: getComputedStyle(svg).color, buttonColor: getComputedStyle(button).color,
          selected: button.getAttribute("aria-current"), variant: svg.getAttribute("data-navigation-glyph-variant") };
      }));
      for (const row of measurements) {
        assert.equal(row.svgWidth, row.expectedSize, JSON.stringify(row)); assert.equal(row.svgHeight, row.expectedSize);
        assert.equal(row.contained, true, JSON.stringify(row)); assert.equal(row.centered, true, JSON.stringify(row));
        assert.equal(row.color, row.buttonColor, "glyph inherits the navigation state, not menu secondary color");
        assert.ok(row.buttonHeight >= (touch ? 44 : 32));
        if (touch) assert.ok(row.buttonWidth >= 44);
      }
      assert.equal(measurements[0].selected, "page"); assert.equal(measurements[0].variant, "selected");
      assert.notEqual(measurements[0].selected, measurements[1].selected);
      assert.equal(await page.locator("#menu svg").evaluate((el: Element) => el.getBoundingClientRect().width), touch ? 18 : 14);
      await invoke("folder");
      assert.equal(await page.getByRole("button", { name: "chat", exact: true }).locator("svg").getAttribute("data-navigation-glyph-variant"), "outline");
      assert.equal(await page.getByRole("button", { name: "folder", exact: true }).locator("svg").getAttribute("data-navigation-glyph-variant"), "selected");
      assert.equal(await page.getByRole("button", { name: "folder", exact: true }).locator("svg").getAttribute("fill"), "none", "Core navigation keeps its line artwork family");
      const normalButton = page.getByRole("button", { name: "server", exact: true });
      await normalButton.hover();
      await normalButton.evaluate(async (el: Element) => {
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
      assert.equal(await normalButton.locator("svg").getAttribute("data-navigation-glyph-variant"), "outline",
        "hover preserves the unselected artwork");
      await page.mouse.move(850, 700);
      await page.screenshot({ path: join(output, `${touch ? "touch" : "mouse"}-${family}-${mode}-${compact ? "compact" : "expanded"}.png`) });
      evidence.push({ touch, family, mode, compact, measurements });
    }
    // Resize expanded rows in both directions and keep the focused action mounted.
    await buttons.first().focus();
    await buttons.first().evaluate((el: Element) => { (window as any).retainedNavigationButton = el; });
    for (const width of [240, 220, 200, 180, 160, 180, 200, 220, 240]) {
      await page.evaluate((width: number) => (window as any).fixture.resize(width), width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await buttons.evaluateAll((elements: HTMLElement[]) => elements.map(button => {
        const glyph = button.querySelector("svg")!;
        const svg = glyph.getBoundingClientRect(), b = button.getBoundingClientRect();
        const frame = button.closest(".navigation-fixture")!.getBoundingClientRect();
        return { width: svg.width, height: svg.height, expectedSize: Number(glyph.getAttribute("width")), contained: svg.left >= b.left && svg.right <= b.right,
          buttonContained: b.left >= frame.left && b.right <= frame.right };
      }));
      assert.ok(geometry.every(row => row.width === row.expectedSize && row.height === row.expectedSize && row.contained && row.buttonContained), JSON.stringify({ touch, width, geometry }));
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
