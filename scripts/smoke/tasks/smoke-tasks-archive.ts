import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS, type TaskDetail, type TasksSnapshot } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd(), data = await mkdtemp(join(tmpdir(), "oc-tasks-archive-ui-"));
const artifacts = process.env.OPENCRAFT_TASKS_ARCHIVE_ARTIFACTS ?? join(root, ".local/tasks-archive");
await mkdir(artifacts, { recursive: true }); await mkdir(join(data, "agent"), { recursive: true });
const service = new TasksService(join(data, "agent/tasks.sqlite"));
const create = (id: string, title: string) => service.handle(TASKS.create, { id, title, description: "Retained original description / 长期留底", acceptanceCriteria: "Retention verified", kind: "growth", status: "backlog", projectId: null, projectServerId: null });
const read = (id: string) => service.handle(TASKS.read, { id }) as TaskDetail;
for (let i = 0; i < 53; i++) { const id = `history-${String(i).padStart(3, "0")}`; create(id, `Historical archive ${i}`); service.handle(TASKS.archive, { id, expectedRevision: 1 }); }
for (const name of ["light", "dark", "touch"]) create(name, `Workflow ${name}`);
const server = await startHeadlessServer({ root, dataDirectory: data, port: 0, webRoot: join(root, "apps/workbench-web/dist"), dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"), codexExecutable: "codex" });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [], cases: unknown[] = [];
try {
 for (const name of ["light", "dark", "touch"] as const) {
  const page = await browser.newPage({ viewport: { width: name === "touch" ? 390 : 1440, height: 900 }, colorScheme: name === "dark" ? "dark" : "light", isMobile: name === "touch", hasTouch: name === "touch" });
  page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("opencraft.appearance-theme", "system"));
  const card = page.locator(`.tasks-card[data-task-id="${name}"]`);
  const boardMore = page.locator('.tasks-heading-actions [aria-haspopup="menu"]');
  const archives = async () => { await boardMore.click(); await page.getByRole("menuitem", { name: "Archived tasks", exact: true }).click(); await page.locator(".tasks-archive").waitFor(); };
  const back = async () => { await page.getByRole("button", { name: "Back to tasks", exact: true }).click(); await page.locator(".tasks-toolbar:visible").waitFor(); };
  await page.goto(server.url + "/views/opencraft.tasks.board");
  if (name === "touch") await page.getByRole("radio", { name: /^Product backlog / }).click();
  await card.waitFor();
  // Unsaved details are retained and must be explicitly saved before archival.
  await card.locator(".tasks-card__title").click();
  const editor = page.locator(".tasks-editor"); await editor.waitFor();
  const title = editor.getByRole("textbox", { name: "Title", exact: true });
  await title.fill(`Workflow ${name} unsaved`);
  assert.equal(await editor.getByRole("button", { name: "Archive task", exact: true }).isDisabled(), true);
  await title.fill(`Workflow ${name}`); assert.equal(await editor.getByRole("button", { name: "Archive task", exact: true }).isEnabled(), true);
  await page.keyboard.press("Escape"); await editor.waitFor({ state: "hidden" });
  await card.hover(); await card.locator('.tasks-card__tools [aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "Archive task", exact: true }).click();
  await card.waitFor({ state: "detached" }); assert.ok(read(name).archivedAt); assert.equal(read(name).status, "backlog");
  await page.reload();
  await page.locator(".tasks-toolbar").waitFor(); assert.equal(await card.count(), 0);
  if (name === "touch") await page.getByRole("radio", { name: /^Product backlog / }).click();
  await page.getByRole("searchbox", { name: "Search tasks…", exact: true }).fill("Workflow");
  await archives();
  await page.waitForFunction(() => document.querySelectorAll('.tasks-archive__list > li').length === 50);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tasks-archive__list > li').length > 50);
  const search = page.getByRole("searchbox", { name: /Search archived titles/ });
  await search.fill("no-such-archive-record"); await page.getByText("No matching archived tasks", { exact: true }).waitFor();
  await search.fill(`Workflow ${name}`);
  const row = page.locator(`.tasks-archive__list [data-task-id="${name}"]`); await row.waitFor();
  await row.locator(".tasks-archive__title").click();
  const detail = page.locator(".tasks-archive-dialog"); await detail.waitFor();
  assert.equal(await detail.locator("input,textarea,select").count(), 0);
  await detail.getByText("Retained original description / 长期留底", { exact: true }).waitFor();
  await detail.getByText("Retention verified", { exact: true }).waitFor();
  await detail.getByText("Archived the item", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, `archive-detail-${name}.png`) });
  await detail.getByRole("button", { name: "Restore to board", exact: true }).click();
  await detail.waitFor({ state: "hidden" }); await row.waitFor({ state: "detached" });
  assert.equal(read(name).archivedAt, null); assert.equal(read(name).status, "backlog");
  await back(); assert.equal(await page.getByRole("searchbox", { name: "Search tasks…", exact: true }).inputValue(), "Workflow");
  await card.waitFor();
  await card.locator(".tasks-card__title").click(); await editor.waitFor();
  await editor.getByRole("button", { name: "Archive task", exact: true }).click();
  await editor.waitFor({ state: "hidden" }); assert.ok(read(name).archivedAt);
  await archives();
  assert.equal(await search.inputValue(), `Workflow ${name}`);
  await row.waitFor(); await row.getByRole("button", { name: `Restore to board: Workflow ${name}`, exact: true }).click();
  await row.waitFor({ state: "detached" }); await back(); await card.waitFor();
  if (name === "light") {
    service.handle(TASKS.archive, { id: name, expectedRevision: read(name).revision });
    await archives(); await row.waitFor(); await row.locator(".tasks-archive__title").click(); await detail.waitFor();
    service.handle(TASKS.unarchive, { id: name, expectedRevision: read(name).revision });
    const winningRevision = read(name).revision;
    await detail.getByRole("button", { name: "Restore to board", exact: true }).click();
    await page.getByText("Another window changed this task. Review the latest content.", { exact: true }).waitFor();
    await detail.waitFor({state:"hidden"}); assert.equal(read(name).revision, winningRevision);
    await back(); await card.waitFor();
  }
  await page.screenshot({ path: join(artifacts, `board-restored-${name}.png`) });
  cases.push({ name, archiveMenu: true, dirtyGuard: true, retainedAfterReload: true, search: true, keysetPaging: true, readOnlyDetails: true, history: true, restoreOriginalStatus: true, filtersRetained: true, detailArchive: true, rowRestore: true });
  await page.close();
 }
 assert.deepEqual(errors, []);
 await writeFile(join(artifacts, "receipt.json"), JSON.stringify({ version: await fetch(server.url + "/version.json").then(r => r.json()), cases, errors, active: (service.handle(TASKS.list, {}) as TasksSnapshot).tasks.length }, null, 2));
 console.log(JSON.stringify({ status: "passed", cases, errors }));
} catch (error) { for (const page of browser.contexts().flatMap(c => c.pages())) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {}); throw error; }
finally { await browser.close(); await server.close(); service.close(); await rm(data, { recursive: true, force: true }); }
