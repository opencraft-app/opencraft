import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { TASKS } from "@opencraft/appserver-protocol";
import { TasksService } from "../../../plugins/tasks/src/server";
import { startHeadlessServer } from "../../headless-server.mjs";

// Complete built Workbench and isolated SQLite. Only native conversation reads
// get synthetic replies; no Turn/model request, real account or live data used.
const root = process.cwd(), data = await mkdtemp(join(tmpdir(), "oc-task-conversation-links-"));
const out = process.env.OPENCRAFT_TASKS_LINKS_ARTIFACTS ?? join(root, ".local/task-conversation-links");
await mkdir(out, { recursive: true }); await mkdir(join(data, "agent"));
const service = new TasksService(join(data, "agent/tasks.sqlite"));
const fixtures = [
  { id: "multiple", title: "auto支持多模态", status: "backlog", links: ["running", "waiting", "failed"] },
  { id: "long", title: "[RM26-10-018][阶段二·运行环境] 公网访问能力", status: "todo", links: ["waiting"] },
  { id: "fallback", title: "整理待推进事项", status: "in_progress", links: ["unknown"] },
  { id: "empty", title: "无需关联会话的任务", status: "backlog", links: [] },
  { id: "unknown-title", title: "保留已有会话入口", status: "todo", links: ["named"] },
  { id: "error", title: "修复回归中发现的问题", status: "in_progress", links: ["failed"] },
  { id: "cross", title: "另一个 Server 上的同名会话 ID", status: "in_progress", links: ["running"] },
  { id: "idle", title: "补充本轮验收记录", status: "in_progress", links: ["idle"] },
] as const;
const titles: Record<string, string> = {
  running: "多模态体验优化", waiting: "[RM26-10-018][阶段二·运行环境] 公网访问能力 / Review a very long conversation title",
  unknown: "unknown", named: "历史讨论：任务管理交互", failed: "回归问题排查", idle: "验收记录",
};
for (const item of fixtures) {
  service.handle(TASKS.create, { id: item.id, title: item.title, description: "Retained description", kind: "feature", status: item.status, projectServerId: null, projectId: null });
  for (const threadId of item.links) {
    const task = service.handle(TASKS.list, {}).tasks.find(task => task.id === item.id)!;
    service.handle(TASKS.attach, { id: item.id, expectedRevision: task.revision, serverId: item.id === "cross" ? "unavailable-server" : "opencraft-server", threadId });
  }
}
const before = JSON.stringify(service.handle(TASKS.list, {}));
const server = await startHeadlessServer({ root, dataDirectory: data, port: 0,
  webRoot: join(root, "apps/workbench-web/dist"), dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
  codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex" });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [], writes: string[] = [], cases: unknown[] = [];
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) for (const palette of ["neutral", "frost"]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ theme, palette }) => {
      localStorage.setItem("opencraft.appearance-theme", theme);
      localStorage.setItem("opencraft.appearance-theme-id", `opencraft.core.${palette}`);
    }, { theme, palette });
    await page.routeWebSocket(/.*/, route => {
      const upstream = route.connectToServer(), reads = new Map<unknown, string>();
      route.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (request.method === "thread/read" && request.params.includeTurns === false) reads.set(request.id, request.params.threadId);
        if (request.method?.startsWith("opencraft/tasks/") && ![TASKS.capabilities, TASKS.list, TASKS.events, TASKS.read].includes(request.method)) writes.push(request.method);
        assert.notEqual(request.method, "turn/start", "The smoke never executes a model");
        upstream.send(raw);
      });
      upstream.onMessage(raw => {
        const reply = JSON.parse(String(raw)), id = reads.get(reply.id);
        if (id) {
          reads.delete(reply.id);
          route.send(JSON.stringify({ jsonrpc: "2.0", id: reply.id, result: { thread: {
            id, name: titles[id], status: id === "running" ? { type: "active", activeFlags: [] }
              : id === "waiting" ? { type: "active", activeFlags: ["waitingOnUserInput"] }
              : id === "failed" ? { type: "systemError" } : id === "idle" ? { type: "idle" } : { type: "unknown" },
          } } }));
        } else route.send(raw);
      });
    });
    const navigate = async (status: string) => {
      await page.goto(server.url + "/views/opencraft.tasks.board");
      await page.locator('.tasks-card[data-task-id="multiple"]').waitFor({ state: "attached" });
      if (width === 390) {
        const labels: Record<string, RegExp> = { backlog: /^Backlog /, todo: /^To do /, in_progress: /^In progress / };
        await page.getByRole("radio", { name: labels[status] }).click();
      }
    };
    await navigate("backlog");
    const multiple = page.locator('[data-task-id="multiple"]');
    await multiple.locator('.tasks-conversation__title').getByText(titles.running, { exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await page.locator('.tasks-card__summary, .tasks-card__activity, .tasks-card__conversation').count(), 0);
    assert.equal(await page.locator('[data-task-id="empty"] .tasks-conversation').count(), 0);
    assert.equal(await multiple.locator('.tasks-conversation__open').count(), 1);
    assert.equal(await multiple.locator('.tasks-conversation__state').innerText(), 'Running');
    await page.screenshot({ path: join(out, `board-${width}-${theme}-${palette}.png`) });
    const more = multiple.getByRole('button', { name: 'View all linked conversations (3)', exact: true });
    await more.click(); await page.locator('.tasks-editor').waitFor();
    assert.equal(await page.locator('.tasks-editor .tasks-link').count(), 3, 'All relations stay available in the existing details owner');
    await page.keyboard.press('Escape'); await page.locator('.tasks-editor').waitFor({ state: 'hidden' });
    const open = multiple.locator('.tasks-conversation__open');
    if (width === 390) assert.ok((await open.boundingBox())!.height >= 44);
    // Keyboard activation has the same navigation destination as pointer input.
    await open.focus(); await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/local/running' && url.searchParams.get('hostId') === 'opencraft-server');
    assert.equal(await page.locator('.tasks-editor').count(), 0, 'Opening a conversation cannot also open task details');
    await navigate('todo');
    const long = page.locator('[data-task-id="long"] .tasks-conversation__open');
    await page.waitForFunction(title => document.querySelector('[data-task-id="long"] .tasks-conversation__title')?.textContent === title, titles.waiting);
    assert.equal(await long.getAttribute('title'), titles.waiting);
    assert.equal(await long.getAttribute('aria-label'), `Open conversation: ${titles.waiting}`);
    assert.ok(await long.locator('.tasks-conversation__title').evaluate(n => n.scrollWidth > n.clientWidth), 'Long title truncates within its own row');
    assert.ok(await long.evaluate(n => n.scrollWidth <= n.clientWidth + 1), 'Row itself does not overflow');
    assert.equal(await long.locator('.tasks-conversation__state').innerText(), 'Waiting');
    if (width === 390) await long.tap(); else await long.click();
    await page.waitForURL(url => url.pathname === '/local/waiting' && url.searchParams.get('hostId') === 'opencraft-server');
    assert.equal(await page.locator('.tasks-editor').count(), 0);
    await navigate('in_progress');
    const fallback = page.locator('[data-task-id="fallback"]');
    await fallback.locator('.tasks-conversation__title').getByText('Open conversation', { exact: true }).waitFor();
    assert.equal(await fallback.locator('.tasks-conversation__state').count(), 0, 'Unknown is omitted, never reclassified as idle');
    assert.equal(await page.locator('[data-task-id="unknown-title"] .tasks-conversation__state').count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-task-id="error"] .tasks-conversation__state')?.textContent === 'Failed');
    assert.equal(await page.locator('[data-task-id="idle"] .tasks-conversation__state').innerText(), 'Idle');
    const cross = page.locator('[data-task-id="cross"] .tasks-conversation');
    assert.equal(await cross.locator('.tasks-conversation__title').innerText(), 'Open conversation');
    assert.equal(await cross.locator('.tasks-conversation__state').count(), 0, 'Same Thread ID on a different Server cannot borrow activity');
    await fallback.locator('.tasks-kind').click(); await page.locator('.tasks-editor').waitFor();
    await page.keyboard.press('Escape'); await page.locator('.tasks-editor').waitFor({ state: 'hidden' });
    if (width === 1440) await page.locator('.tasks-columns').evaluate(el => { el.scrollLeft = 0; });
    await page.screenshot({ path: join(out, `${width}-${theme}-${palette}.png`) });
    assert.equal(JSON.stringify(service.handle(TASKS.list, {})), before, 'Navigation and disclosure preserve task authority');
    cases.push({ width, theme, palette, directNavigation: true, overflowDetails: true, longTitle: true, unknownFallback: true, keyboard: true });
    await context.close();
  }
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  const receipt = { passed: true, cases, errors, writes, paidInference: false, syntheticConversationReads: true };
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser.close(); await server.close(); service.close(); await rm(data, { recursive: true, force: true }); }
