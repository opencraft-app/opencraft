import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startHeadlessServer } from "../../headless-server.mjs";

// Isolated Host/data directory, real filesystem reads and complete built Workbench.
// An optional URL must already be accessible; this probe does not supply credentials.
const output = process.env.OPENCRAFT_FILE_TREE_ARTIFACTS ?? await mkdtemp(join(tmpdir(), "oc-file-tree-runtime-"));
await mkdir(output, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "oc-file-tree-host-"));
const server = process.env.OPENCRAFT_FILE_TREE_URL ? undefined : await startHeadlessServer({
  root: process.cwd(), dataDirectory: data, port: 0,
  webRoot: process.env.OPENCRAFT_FILE_TREE_WEB_ROOT ?? join(process.cwd(), "apps/workbench-web/dist"),
  dshCapabilityPlugin: join(process.cwd(), "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
  codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex",
});
const base = process.env.OPENCRAFT_FILE_TREE_URL ?? server!.url;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const cases = [];
try {
  for (const sidebar of [true, false]) for (const cpu of [1, 4]) {
    console.log(JSON.stringify({ phase: "start", sidebar, cpu, base }));
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await page.goto(base);
    const open = page.getByRole("button", { name: "Open preview panel", exact: true }).filter({ visible: true });
    await open.waitFor();
    if (!sidebar) await page.getByRole("button", { name: "Hide sidebar", exact: true }).filter({ visible: true }).click();
    await open.click();
    const files = page.getByRole("button", { name: "Open files", exact: true });
    await files.waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.evaluate(() => {
      const state = (window as any).probe = { gaps: [] as number[], longTasks: [] as number[] };
      new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: "longtask" });
      let last = performance.now();
      setInterval(() => { const now = performance.now(); state.gaps.push(now - last); last = now; }, 50);
    });
    await files.click();
    console.log(JSON.stringify({ phase: "files-open", sidebar, cpu }));
    const tree = page.getByRole("tree", { name: "Workspace files" });
    const directory = tree.locator('[title="/data"]');
    await directory.waitFor();
    await directory.click();
    console.log(JSON.stringify({ phase: "data-expanded", sidebar, cpu, rowCount: await tree.getAttribute("data-row-count") }));
    await page.waitForFunction(() => Number(document.querySelector('[role="tree"]')?.getAttribute("data-row-count")) > 3000);
    await page.waitForTimeout(1200);
    const measurement = await page.evaluate(() => ({
      rows: Number(document.querySelector('[role="tree"]')?.getAttribute("data-row-count")),
      mountedRows: document.querySelectorAll(".workspace-file-tree__row").length,
      domNodes: document.querySelectorAll("*").length,
      maxGapMs: Math.max(...(window as any).probe.gaps),
      longTasksMs: (window as any).probe.longTasks,
    }));
    assert.ok(measurement.mountedRows < 80);
    await tree.focus(); await tree.press("End");
    assert.ok(await tree.evaluate(element => element.scrollTop) > 50_000);
    await tree.press("Home");
    if (sidebar && cpu === 1) await page.screenshot({ path: join(output, "files.png") });
    assert.deepEqual(errors, []);
    cases.push({ sidebar, cpu, ...measurement });
    await page.close();
  }
  const version = await fetch(base + "/version.json").then(response => response.json());
  await writeFile(join(output, "receipt.json"), JSON.stringify({ passed: true, version, cases }, null, 2));
  console.log(JSON.stringify({ passed: true, output, version, cases }));
} finally {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: join(output, "last-page.png") }).catch(() => undefined);
  }
  await browser.close(); await server?.close();
}
