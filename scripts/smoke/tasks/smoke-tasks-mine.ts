import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd(), data = await mkdtemp(join(tmpdir(), "oc-tasks-mine-"));
const artifacts = process.env.OPENCRAFT_TASKS_MINE_ARTIFACTS ?? join(root, ".local/tasks-mine");
await mkdir(join(data, "agent"), { recursive: true }); await mkdir(artifacts, { recursive: true });
const seed = new TasksService(join(data, "agent/tasks.sqlite"));
for (const id of ["alex", "sam"]) seed.handle(TASKS.members, { id, name: id === "alex" ? "Sam" : "Alex", expectedRevision: null });
for (const [id, assigneeId, priority] of [["task-a", "alex", "high"], ["task-b", "alex", "normal"], ["task-c", "sam", "normal"], ["task-d", null, "none"]] as const)
  seed.handle(TASKS.create, { id, title: id === "task-a" ? "Stability verification" : id, status: "todo", description: "", assigneeId, priority, dueDate: null, projectServerId: null, projectId: null });
const before = JSON.stringify(seed.handle(TASKS.list, {})); seed.close();
const server = await startHeadlessServer({ root, dataDirectory: data, webRoot: join(root, "apps/workbench-web/dist"), dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"), codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex", port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [];
try {
  // Only the external gateway identity response is synthetic. Actual extension activation,
  // account projection, preference persistence, task Host and Workbench are exercised.
  for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 430, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
    try {
      let identity: { loginName: string; staffId: string; expiresAt: string } | null = null;
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.clock.install();
      await page.addInitScript(() => localStorage.setItem("opencraft.appearance-theme", "system"));
      await page.emulateMedia({ colorScheme: theme });
      await page.route("**/__opencraft_enterprise_identity/session", route => route.fulfill({ status: identity ? 200 : 401, contentType: "application/json", body: JSON.stringify({ available: true, identity }) }));
      const board = server.url + "/views/opencraft.tasks.board";
      const mine = page.getByRole("button", { name: "My tasks", exact: true });
      const member = page.getByLabel("My member account", { exact: true });
      const ids = () => page.locator('.tasks-card:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-task-id")).sort());
      await page.goto(board); await mine.waitFor();
      await mine.click(); await member.waitFor();
      assert.deepEqual(await ids(), [], "Anonymous user is never inferred from a roster display name");
      await member.selectOption("alex"); assert.deepEqual(await ids(), ["task-a", "task-b"]);
      await page.screenshot({ path: join(artifacts, `manual-${width}-${theme}.png`), animations: "disabled" });
      await page.reload(); await mine.click();
      assert.equal(await member.inputValue(), "alex", "Explicit local preference survives refresh");
      assert.deepEqual(await ids(), ["task-a", "task-b"]);
      await page.getByRole("radio", { name: "List", exact: true }).click();
      assert.equal(await page.locator('.tasks-row').count(), 2);
      await page.getByLabel("Search tasks…", { exact: true }).fill("Stability");
      assert.equal(await page.locator('.tasks-row').count(), 1);
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      assert.equal(await page.locator('.tasks-row').count(), 4);
      await page.getByRole("radio", { name: "Board", exact: true }).click();
      // Authenticated account must not reuse the anonymous manual choice.
      identity = { loginName: "sam", staffId: "22", expiresAt: new Date(Date.now() + 600_000).toISOString() };
      await page.reload(); await mine.click();
      assert.deepEqual(await ids(), ["task-c"], "Verified handle resolves through shared platform projection, not the member display name");
      assert.equal(await member.count(), 0);
      const box = await mine.boundingBox(); assert.ok(box && (width >= 600 || box.height >= 44));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width < 600) { const toolbar = await page.locator('.tasks-toolbar').boundingBox(); assert.ok(toolbar && toolbar.height <= 46); }
      await page.screenshot({ path: join(artifacts, `verified-${width}-${theme}.png`), animations: "disabled" });
      // Refresh shared identity while the same Task view stays mounted.
      identity = { ...identity, loginName: "alex", staffId: "11" };
      await page.clock.fastForward(61_000);
      const refreshed = page.waitForResponse(response => response.url().endsWith("/__opencraft_enterprise_identity/session"));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await refreshed;
      await page.waitForFunction(() => document.querySelectorAll(".tasks-card").length === 2);
      assert.deepEqual(await ids(), ["task-a", "task-b"], "A mounted view follows the new verified identity");
      assert.equal(await mine.getAttribute("aria-pressed"), "true");
      await mine.click(); assert.equal((await ids()).length, 4, "Second click returns to all owners");
      // An unknown authenticated account requires an explicit choice in its own scope.
      identity = { ...identity, loginName: "external", staffId: "33" };
      await page.reload(); await mine.click(); await member.waitFor(); assert.equal(await member.inputValue(), "");
      await member.selectOption("sam"); assert.deepEqual(await ids(), ["task-c"]);
      identity = { ...identity, loginName: "another", staffId: "44" };
      await page.reload(); await mine.click(); await member.waitFor(); assert.equal(await member.inputValue(), "", "Account switch cannot inherit another account's manual mapping");
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  const check = new TasksService(join(data, "agent/tasks.sqlite"));
  assert.equal(JSON.stringify(check.handle(TASKS.list, {})), before, "Viewing preferences never mutate tasks"); check.close();
  console.log(JSON.stringify({ passed: true, cases: ["8 desktop/touch light/dark scenes", "anonymous explicit selection", "refresh persistence", "search and list intersection", "clear/toggle", "verified platform account handle", "unknown account selection", "account scope isolation", "no task writes or page errors"], artifacts }));
} finally { await browser.close(); await server.close(); await rm(data, { recursive: true, force: true }); }
