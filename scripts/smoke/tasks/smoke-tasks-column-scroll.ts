import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), "oc-tasks-column-scroll-"));
const artifacts = process.env.OPENCRAFT_TASKS_SCROLL_ARTIFACTS ?? join(root, ".local/tasks-column-scroll");
const baseline = process.env.OPENCRAFT_TASKS_SCROLL_BASELINE === "1";
await mkdir(join(data, "agent"), { recursive: true });
await mkdir(artifacts, { recursive: true });
const service = new TasksService(join(data, "agent/tasks.sqlite"));
for (let i = 0; i < 40; i++) service.handle(TASKS.create, {
  id: `scroll-${i}`, title: `[RM26-${String(i).padStart(3, "0")}] 用户场景挖掘与产品使用数据 / Task ${i}`,
  description: "Synthetic scroll fixture", status: i < 36 ? "backlog" : "todo",
  projectServerId: null, projectId: null,
});
const before = JSON.stringify(service.handle(TASKS.list, {}));
const server = await startHeadlessServer({ root, dataDirectory: data,
  webRoot: join(root, "apps/workbench-web/dist"),
  dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
  codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex", port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [], results: unknown[] = [];
const cases = baseline ? [{ width: 1440, theme: "light", palette: "neutral" }] :
  ["light", "dark"].flatMap(theme => [320, 390, 430, 600, 601, 820, 1440].map(width => ({ width, theme, palette: "neutral" })))
    .concat(["frost", "mist", "graphite"].flatMap(palette => ["light", "dark"].map(theme => ({ width: 1440, theme, palette }))));
try {
  for (const { width, theme, palette } of cases) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript((id: string) => {
        localStorage.setItem("opencraft.appearance-theme", "system");
        localStorage.setItem("opencraft.appearance-theme-id", `opencraft.core.${id}`);
      }, palette);
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
      await page.goto(server.url + "/views/opencraft.tasks.board");
      const column = page.locator('.tasks-column[data-column="product_backlog"]');
      await column.waitFor({ state: "attached" });
      if (!(await column.isVisible())) await page.getByRole("radio", { name: /^Product backlog / }).click();
      await column.locator(".tasks-card").first().waitFor();
      const node = await column.elementHandle();
      const header = column.locator(":scope > header");
      const mobile = !(await header.isVisible());
      const containerWidth = await page.locator(".tasks-viewport").evaluate((el: HTMLElement) => el.clientWidth);
      assert.equal(mobile, containerWidth <= 600, "Layout follows the task container breakpoint");
      const scroll = async (top: number) => {
        await column.evaluate((el: HTMLElement, value: number) => { el.scrollTop = value; }, top);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await column.evaluate((el: HTMLElement) => el.scrollTop), top);
      };
      await scroll(147);
      const label = `${width}-${theme}-${palette}`;
      let background: string | undefined;
      if (!mobile) {
        const first = await header.boundingBox(); const box = await column.boundingBox();
        assert.ok(first && box);
        const clip = { x: Math.ceil(first.x + 3), y: Math.ceil(Math.max(first.y, box.y) + 2),
          width: Math.floor(first.width - 6), height: Math.floor(first.y + first.height - Math.max(first.y, box.y) - 4) };
        await page.mouse.move(0, 0);
        const a = await page.screenshot({ clip, animations: "disabled" });
        await scroll(491);
        const second = await header.boundingBox(); assert.ok(second);
        assert.ok(Math.abs(first.y - second.y) < 1, "Column title remains sticky while cards scroll");
        const b = await page.screenshot({ clip, animations: "disabled" });
        background = await header.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
        if (baseline) {
          assert.equal(background, "rgba(0, 0, 0, 0)");
          assert.equal(a.equals(b), false, "Negative baseline: moving card text changes pixels inside the transparent header");
        } else {
          assert.match(background, /^rgb\(/, "Sticky title uses an opaque theme surface");
          assert.ok(a.equals(b), "Moving cards cannot change any pixels inside the sticky title");
          await column.getByRole("button", { name: /: Product backlog$/ }).click();
          await page.getByRole("dialog").waitFor();
          assert.equal(await page.getByRole("dialog").getByLabel("Task status", { exact: true }).inputValue(), "backlog");
          await page.keyboard.press("Escape");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          assert.equal(await column.evaluate((el: HTMLElement) => el.scrollTop), 491);
          if (width === 1440 && palette === "neutral") {
            await page.setViewportSize({ width: 390, height: 900 });
            await page.getByRole("radio", { name: /^Product backlog / }).click();
            assert.equal(await header.isVisible(), false);
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await header.isVisible(), true);
            assert.equal(await column.evaluate((el: HTMLElement) => el.scrollTop), 491, "Resizing retains the original scroll position");
          }
        }
      } else {
        assert.equal(await page.locator(".tasks-column:visible").count(), 1);
        // Shared status navigation stays the sole mobile status header.
        const status = page.getByRole("radio", { name: /^To do / });
        await status.click();
        await page.getByRole("radio", { name: /^Product backlog / }).click();
        assert.equal(await column.evaluate((el: HTMLElement) => el.scrollTop), 147, "Status switches restore the original column position");
        const taskBox = await page.locator(".tasks").boundingBox();
        const columnBox = await column.boundingBox(); assert.ok(taskBox && columnBox);
        assert.ok(columnBox.y - taskBox.y <= 151, "Compact mobile chrome retains its existing height");
      }
      assert.ok(await node!.evaluate((el: Element) => el.isConnected), "Scroll and status changes preserve the column node");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifacts, `${baseline ? "before" : "after"}-${label}.png`), animations: "disabled" });
      results.push({ width, containerWidth, theme, palette, mobile, background });
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  assert.equal(JSON.stringify(service.handle(TASKS.list, {})), before, "Scrolling and dismissal never write task data");
  const receipt = { passed: true, baseline, cases: results, errors, artifacts };
  await writeFile(join(artifacts, baseline ? "baseline.json" : "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { await browser.close(); await server.close(); service.close(); await rm(data, { recursive: true, force: true }); }
