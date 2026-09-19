import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const probe = `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ThreadRowMenu} from '/apps/workbench-web/src/components/thread-management.tsx'; import '/apps/workbench-web/src/styles/app.scss';
function Probe(){const [title,setTitle]=useState('Fixture thread');return <ThreadRowMenu target={{hostId:'local',threadId:'fixture',title}} capabilities={{rename:true,archive:true,fork:true}}
onRename={async(_key,title)=>{setTitle(title);window.fixture.push(['rename',title]);}} onFork={async()=>{window.fixture.push(['fork']);}} onArchive={async()=>{window.fixture.push(['archive']);}}><button>{title}</button></ThreadRowMenu>}
window.fixture=[];createRoot(document.getElementById('root')).render(<Probe/>);`;
const probeId = "/thread-probe.tsx";
const server = await createServer({ root: process.cwd(), configFile: false, cacheDir: "node_modules/.vite-thread-management", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-context-menu", "@radix-ui/react-dialog", "@radix-ui/react-popover", "@tanstack/react-query", "void-elements"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "thread-management-probe", enforce: "pre",
    resolveId(id) { if (id === probeId) return probeId; }, load(id) { if (id === probeId) return probe; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/thread-probe.tsx"></script>'); }); } }] });
let browser: any;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage(); page.setDefaultTimeout(8000);
  page.on("pageerror", (error: Error) => console.error("UI probe error:", error.message));
  page.on("response", (response: any) => { if (response.status() >= 400) console.error("UI probe response:", response.status(), response.url()); });
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as any).port}`);
  await page.getByRole("button", { name: "Fixture thread", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const input = page.getByRole("textbox", { name: "会话名称" }); await input.fill("Renamed fixture");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "Renamed fixture", exact: true }).waitFor();
  await page.getByRole("button", { name: "Renamed fixture", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建分支" }).click();
  await page.getByRole("button", { name: "Renamed fixture", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "归档" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).fixture), [["rename", "Renamed fixture"], ["fork"], ["archive"]]);
  console.log("PASS: real Radix thread context menu, themed rename dialog and typed fork/archive actions");
} finally { await browser?.close(); await server.close(); }
