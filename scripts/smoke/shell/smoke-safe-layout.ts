import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SAFE_LAYOUT_ARTIFACT_DIR ?? "/tmp/opencraft-safe-layout";
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SafeLayout} from '@opencraft/design-system-web/safe-layout';
function App(){const [bottom,setBottom]=useState(true);window.setBottom=setBottom;
return <SafeLayout as="aside" id="surface" edges={bottom?['top','right','bottom','left']:['top','right','left']} minimumInsets={{bottom:16}} style={{height:'100dvh',background:'linear-gradient(var(--paint),var(--paint))',paddingBottom:7}}>
<SafeLayout id="nested" edges={[]}><input aria-label="Draft" defaultValue="Preserved draft"/></SafeLayout>
</SafeLayout>;}createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "safe-layout-probe",
    resolveId: id => id === "/safe-probe.tsx" ? id : null,
    load: id => id === "/safe-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}html{--safe-layout-inset-top:47px;--safe-layout-inset-right:26px;--safe-layout-inset-bottom:34px;--safe-layout-inset-left:22px;--paint:#f8f6ff}input{box-sizing:border-box;width:100%}</style><div id="root"></div><script type="module" src="/safe-probe.tsx"></script>');
    }); },
  }] });
let browser: any;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(vite.resolvedUrls!.local[0]); await page.locator("input").waitFor();
  await page.locator("input").fill("Keep selection and focus");
  await page.evaluate(() => { const input = document.querySelector("input")!; input.setSelectionRange(2, 8); (window as any).originalInput = input; });
  for (const paint of ["#f8f6ff", "#17141f"]) {
    for (const [width, height, top, bottom] of [[390, 844, 47, 34], [844, 390, 0, 60]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ paint, top, bottom }) => { const s = document.documentElement.style;
        s.setProperty("--paint", paint); s.setProperty("--safe-layout-inset-top", `${top}px`);
        s.setProperty("--safe-layout-inset-bottom", `${bottom}px`); }, { paint, top, bottom });
      const geometry = await page.evaluate(() => { const surface = document.querySelector<HTMLElement>("#surface")!;
        const nested = document.querySelector<HTMLElement>("#nested")!; const input = document.querySelector("input")!;
        const s = getComputedStyle(surface), box = surface.getBoundingClientRect();
        return { tag: surface.tagName, top: box.top, bottom: box.bottom, height: box.height,
          padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft], nestedTop: nested.getBoundingClientRect().top,
          background: s.backgroundImage, sameNode: input === (window as any).originalInput,
          value: input.value, selection: [input.selectionStart, input.selectionEnd], focused: document.activeElement === input };
      });
      assert.equal(geometry.tag, "ASIDE"); assert.equal(geometry.top, 0); assert.equal(geometry.height, height);
      assert.deepEqual(geometry.padding, [`${top}px`, "26px", `${bottom}px`, "22px"]);
      assert.equal(geometry.nestedTop, top, "nested content does not reclaim an allocated edge");
      assert.ok(geometry.background.includes(paint === "#f8f6ff" ? "248, 246, 255" : "23, 20, 31"));
      assert.ok(geometry.sameNode && geometry.focused); assert.equal(geometry.value, "Keep selection and focus");
      assert.deepEqual(geometry.selection, [2, 8]); results.push({ paint, width, height, geometry });
      await page.screenshot({ path: `${output}/${paint.slice(1)}-${width}.png` });
    }
  }
  await page.evaluate(() => (window as any).setBottom(false));
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#surface")!).paddingBottom === "7px");
  assert.equal(await page.evaluate(() => document.querySelector("input") === (window as any).originalInput), true);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, results, boundary: "Chromium with explicit CSS inset projections; no native system status-bar evidence" }, null, 2));
  console.log("SafeLayout full-bleed paint, explicit/nested edges, spacing, rotation, theme and draft/focus continuity passed");
} finally { await browser?.close(); await vite.close(); }
