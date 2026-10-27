import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS, type TasksSnapshot } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd(), data = await mkdtemp(join(tmpdir(), "oc-task-avatars-"));
const artifacts = process.env.OPENCRAFT_TASKS_AVATAR_ARTIFACTS ?? join(root, ".local/tasks-avatars");
await mkdir(join(data, "agent"), { recursive: true }); await mkdir(artifacts, { recursive: true });
const service = new TasksService(join(data, "agent/tasks.sqlite"));
for (const [id, name, identity] of [["owner-a", "Alex Chen", { kind: "employee", id: "employee.alex" }], ["owner-b", "Beth Ray", { kind: "employee", id: "employee.broken" }], ["owner-c", "陈可", null], ["owner-d", "Dana Park", { kind: "unknown", id: "unknown" }]] as const)
  service.handle(TASKS.members, { id, name, expectedRevision: null, identity });
for (const [i, assigneeId] of ["owner-a", "owner-b", "owner-c", "owner-d", null].entries())
  service.handle(TASKS.create, { id: `task-${i}`, title: `Task ${i}`, description: "Keep the task draft", status: "todo", projectServerId: null, projectId: null, assigneeId, ...(i === 1 ? { priority: "high", dueDate: "2026-12-20" } : {}) });
const snapshot = () => service.handle(TASKS.list, {}) as TasksSnapshot;
const tasksBefore = JSON.stringify(snapshot().tasks);
const server = await startHeadlessServer({ root, dataDirectory: data, webRoot: process.env.OPENCRAFT_TASKS_AVATAR_WEB_ROOT ?? join(root, "apps/workbench-web/dist"), dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"), codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex", port: 0 });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nO3NQQkAAAgEsItvBbNYzhQ+hMH+S/WcikAgEAgEAoFAIPgSLOSIcGqKjAmIAAAAAElFTkSuQmCC", "base64");
try {
  for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 430, 1440]) {
    const a = snapshot().members!.find(member => member.id === "owner-a")!;
    service.handle(TASKS.members, { id: a.id, name: a.name, expectedRevision: a.revision, identity: { kind: "employee", id: "employee.alex" } });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem("opencraft.appearance-theme", "system")); await page.emulateMedia({ colorScheme: theme });
      // External identity service and image network are the only browser substitutes.
      await page.route("**/__opencraft_enterprise_identity/session", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ available: true, identity: null }) }));
      const photos: string[] = [];
      let releasePhoto!: () => void;
      const pendingPhoto = new Promise<void>(resolve => { releasePhoto = resolve; });
      await page.route("https://directory.example.com/photo/150/**", async route => {
        photos.push(route.request().url());
        if (route.request().url().endsWith("employee.alex.png")) {
          await pendingPhoto;
          return route.fulfill({ status: 200, contentType: "image/png", body: png });
        }
        return route.fulfill({ status: 404, body: "" });
      });
      await page.goto(server.url + "/views/opencraft.tasks.board");
      const card = (id: number) => page.locator(`.tasks-card[data-task-id="task-${id}"]`);
      await card(0).locator(".tasks-avatar img").waitFor({ state: "attached" });
      assert.equal(await card(0).locator(".tasks-avatar").textContent(), "AC", "Pending photos keep initials visible, even if the network never replies");
      assert.equal(await card(0).locator(".tasks-avatar img").isVisible(), false);
      const pendingGeometry = await card(0).locator(".tasks-avatar").boundingBox();
      assert.ok(pendingGeometry && pendingGeometry.width === 24 && pendingGeometry.height === 24);
      if (width === 390) await page.screenshot({ path: join(artifacts, `pending-${theme}.png`), animations: "disabled" });
      releasePhoto();
      await card(0).locator(".tasks-avatar img").waitFor();
      assert.equal(await card(0).locator(".tasks-avatar").textContent(), "", "Loaded photos replace the fallback");
      await page.waitForFunction(() => (document.querySelector('.tasks-card[data-task-id="task-0"] .tasks-avatar img') as HTMLImageElement)?.naturalWidth > 0);
      await page.waitForFunction(() => document.querySelector('.tasks-card[data-task-id="task-1"] .tasks-avatar')?.textContent === "BR");
      assert.equal(await card(2).locator(".tasks-avatar").textContent(), "陈"); assert.equal(await card(3).locator(".tasks-avatar").textContent(), "DP");
      assert.ok(photos.every(url => /employee\.(alex|broken)\.png$/.test(url)), "Only explicitly bound employee identities reach the photo provider");
      const geometry = await card(0).locator(".tasks-avatar").boundingBox(); assert.ok(geometry && geometry.width === 24 && geometry.height === 24);
      for (const id of [0, 1, 2, 3, 4]) {
        const owner = card(id).locator(".tasks-owner");
        assert.equal(await owner.locator(".tasks-owner__name").count(), 0, "Cards show only the avatar, including unassigned tasks");
        assert.match((await owner.getAttribute("aria-label"))!, /^Assignee: /);
        assert.equal(await owner.getAttribute("role"), "img");
        assert.equal(await owner.getAttribute("title"), await owner.getAttribute("aria-label"));
        const position = await card(id).evaluate((el: HTMLElement) => {
          const c = el.getBoundingClientRect(), a = el.querySelector(".tasks-avatar")!.getBoundingClientRect(), s = getComputedStyle(el);
          return { left: a.left - c.left, bottom: c.bottom - a.bottom, paddingLeft: parseFloat(s.paddingLeft), paddingBottom: parseFloat(s.paddingBottom) };
        });
        assert.ok(Math.abs(position.left - position.paddingLeft - 1) <= 1, `Avatar ${id} follows the card's left content edge: ${JSON.stringify(position)}`);
        assert.ok(Math.abs(position.bottom - position.paddingBottom - 1) <= 1, "Avatar stays at the bottom content edge");
      }
      const priority = await card(1).locator(".tasks-priority").boundingBox();
      const due = await card(1).locator(".tasks-due").boundingBox();
      const owner = await card(1).locator(".tasks-owner").boundingBox();
      assert.ok(priority && due && owner && priority.x >= owner.x + owner.width && due.x >= priority.x + priority.width, "Priority and date remain visible without covering the avatar");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifacts, `board-${width}-${theme}.png`), animations: "disabled" });
      await page.getByRole("radio", { name: "List", exact: true }).click();
      assert.equal(await page.locator(".tasks-row").count(), 5);
      assert.equal(await page.locator('[data-task-id="task-0"] .tasks-owner__name').textContent(), "Alex Chen", "List rows retain identifiable names");
      await page.locator('[data-task-id="task-0"] .tasks-row__title').click();
      const dialog = page.getByRole("dialog", { name: "Task details", exact: true }); await dialog.waitFor();
      await dialog.getByText("Avatar profile · Alex Chen", { exact: true }).click();
      await dialog.getByLabel("Identity account", { exact: true }).fill("employee.broken");
      if (width === 390 && theme === "light") await page.screenshot({ path: join(artifacts, "profile-390-light.png"), animations: "disabled" });
      if (width === 390 && theme === "light") {
        const current = snapshot().members!.find(member => member.id === "owner-a")!;
        service.handle(TASKS.members, { id: current.id, name: current.name, expectedRevision: current.revision, identity: { kind: "employee", id: "employee.revised" } });
        await dialog.getByRole("button", { name: "Load latest profile", exact: true }).waitFor();
        assert.equal(await dialog.getByLabel("Identity account", { exact: true }).inputValue(), "employee.broken", "Concurrent metadata updates retain the unsaved profile draft");
        assert.equal(await dialog.getByRole("button", { name: "Save avatar profile", exact: true }).isDisabled(), true);
        await dialog.getByRole("button", { name: "Load latest profile", exact: true }).click();
        assert.equal(await dialog.getByLabel("Identity account", { exact: true }).inputValue(), "employee.revised");
        await dialog.getByLabel("Identity account", { exact: true }).fill("employee.broken");
      }
      await dialog.getByRole("button", { name: "Save avatar profile", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".tasks-member-profile[open]"));
      assert.equal(snapshot().members!.find(member => member.id === "owner-a")!.identity?.id, "employee.broken");
      await dialog.getByText("Avatar profile · Alex Chen", { exact: true }).click();
      await dialog.getByLabel("Identity kind", { exact: true }).selectOption("");
      await dialog.getByRole("button", { name: "Save avatar profile", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".tasks-member-profile[open]"));
      assert.equal(snapshot().members!.find(member => member.id === "owner-a")!.identity, null);
      await page.getByRole("button", { name: "Close task details", exact: true }).click();
      const row = page.locator('.tasks-row[data-task-id="task-0"]'); assert.equal(await row.locator(".tasks-avatar").textContent(), "AC");
      await page.getByRole("button", { name: "My tasks", exact: true }).click();
      await page.getByLabel("My member account", { exact: true }).selectOption("owner-a"); assert.equal(await page.locator(".tasks-row").count(), 1);
      assert.equal(JSON.stringify(snapshot().tasks), tasksBefore, "Profile maintenance cannot change a task, responsibility or revision");
    } finally { await context.close(); }
  }
  // enterprise identity is absent at activation; all profile references still leave ordinary tasks operational.
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await page.route("**/__opencraft_enterprise_identity/session", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ available: false, identity: null }) }));
    let photoRequests = 0; await page.route("https://directory.example.com/photo/150/**", route => { photoRequests++; return route.abort(); });
    await page.goto(server.url + "/views/opencraft.tasks.board"); const card = page.locator('.tasks-card[data-task-id="task-1"]'); await card.waitFor();
    assert.equal(await card.locator(".tasks-avatar").textContent(), "BR"); assert.equal(await page.locator(".tasks-avatar img").count(), 0);
    await page.locator('.tasks-card[data-task-id="task-0"] .tasks-card__title').click();
    const dialog = page.getByRole("dialog", { name: "Task details", exact: true });
    await dialog.getByLabel("Assignee", { exact: true }).selectOption("owner-b"); await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.tasks-card[data-task-id="task-0"] .tasks-owner')?.getAttribute("aria-label") === "Assignee: Beth Ray");
    await page.getByRole("button", { name: "Close task details", exact: true }).click();
    assert.equal(snapshot().tasks.find(task => task.id === "task-0")!.assigneeId, "owner-b"); assert.equal(photoRequests, 0);
    await page.screenshot({ path: join(artifacts, "no-ioa.png"), animations: "disabled" });
  } finally { await context.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases: ["8 desktop/touch light/dark scenes", "real shared enterprise identity avatar provider", "pending photo keeps initials/loaded photo replaces fallback/404/missing identity/unknown kind", "UI edit and clear persisted profile", "profile changes preserve task rows and revisions", "My tasks with initials", "enterprise identity absent and ordinary assignment works", "24px geometry and no overflow", "zero page errors"], artifacts }));
} finally { service.close(); await browser.close(); await server.close(); await rm(data, { recursive: true, force: true }); }
