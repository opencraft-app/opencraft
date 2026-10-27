import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "@opencraft/appserver-protocol";
import { TasksService } from "../../../plugins/tasks/src/server";
import { startHeadlessServer } from "../../headless-server.mjs";
import { chromium, type WebSocketRoute } from "playwright";

// Full built Workbench, real read authority. Only the browser's read replies are
// held/replaced; production/LAN mode never seeds or mutates existing tasks.
const root = process.cwd();
const out = process.env.OPENCRAFT_TASKS_LOADING_ARTIFACTS ?? join(root, ".local/tasks-loading");
await mkdir(out, { recursive: true });
let base = process.env.OPENCRAFT_TASKS_LOADING_URL;
let data: string | undefined, service: TasksService | undefined;
let server: Awaited<ReturnType<typeof startHeadlessServer>> | undefined;
if (!base) {
  data = await mkdtemp(join(tmpdir(), "oc-tasks-loading-"));
  await mkdir(join(data, "agent")); service = new TasksService(join(data, "agent/tasks.sqlite"));
  for (let i = 0; i < 20; i++) service.handle(TASKS.create, {
    id: `loading-${i}`, title: `产品需求 ${i}`, description: "Retained description",
    kind: "feature", status: "todo", projectServerId: null, projectId: null,
  });
  server = await startHeadlessServer({ root, dataDirectory: data, port: 0,
    webRoot: join(root, "apps/workbench-web/dist"),
    dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
    codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex" });
  base = server.url;
}
const before = service ? JSON.stringify(service.handle(TASKS.list, {})) : undefined;
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [], writes: string[] = [], cases: unknown[] = [];
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 920 }, hasTouch: width === 390, isMobile: width === 390, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.addInitScript(preference => localStorage.setItem("opencraft.appearance-theme", preference), theme);
    page.on("pageerror", e => errors.push(e.message));
    let heldMethod: string | null = TASKS.capabilities;
    type Reply = { route: WebSocketRoute; raw: string | Buffer };
    let held: Reply[] = [];
    await page.routeWebSocket(/.*/, route => {
      const upstream = route.connectToServer(), methods = new Map<unknown, string>();
      route.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (typeof request.method === "string") {
          methods.set(request.id, request.method);
          if (request.method.startsWith("opencraft/tasks/") && ![TASKS.capabilities, TASKS.list, TASKS.events, TASKS.read].includes(request.method)) writes.push(request.method);
        }
        upstream.send(raw);
      });
      upstream.onMessage(raw => {
        const reply = JSON.parse(String(raw)), method = methods.get(reply.id);
        methods.delete(reply.id);
        if (method === heldMethod) held.push({ route, raw }); else route.send(raw);
      });
    });
    const waitHeld = async () => {
      for (let i = 0; !held.length && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(held.length, "Expected read boundary was reached");
    };
    const release = (replacement?: "error" | "empty") => {
      const replies = held; held = [];
      for (const { route, raw } of replies) {
        const reply = JSON.parse(String(raw));
        route.send(replacement === "error" ? JSON.stringify({ jsonrpc: "2.0", id: reply.id, error: { code: -32000, message: "Synthetic read outage" } })
          : replacement === "empty" ? JSON.stringify({ ...reply, result: { ...reply.result, tasks: [], recycled: [] } }) : raw);
      }
    };
    const refresh = async () => {
      if (width === 390) {
        await page.getByRole("button", { name: "More actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Refresh board", exact: true }).click();
      } else await page.getByRole("button", { name: "Refresh board", exact: true }).click();
    };
    const skeleton = page.locator(".tasks-loading");
    const assertCold = async () => {
      await skeleton.waitFor();
      assert.equal(await skeleton.getAttribute("aria-busy"), "true");
      assert.equal(await page.locator(".tasks-active-view").count(), 0);
      assert.equal(await page.locator(".tasks-card, .tasks-column__add").count(), 0);
      assert.equal(await page.getByText("No tasks yet", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "New task", exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    };
    await page.goto(base + "/views/opencraft.tasks.board"); await waitHeld(); await assertCold();
    await page.screenshot({ path: join(out, `cold-capabilities-${width}-${theme}.png`) });
    assert.equal(await skeleton.locator(".tasks-column:visible").count(), width === 390 ? 1 : 7);
    heldMethod = TASKS.list; release(); await waitHeld(); await assertCold();
    await page.getByRole("radio", { name: "List", exact: true }).click();
    assert.equal(await skeleton.locator(".tasks-loading__row").count(), 6);
    await page.screenshot({ path: join(out, `cold-list-${width}-${theme}.png`) });
    await page.getByRole("radio", { name: "Board", exact: true }).click();
    heldMethod = null; release("error");
    await page.locator(".tasks-load-error").waitFor();
    assert.equal(await skeleton.count(), 0); assert.equal(await page.locator(".tasks-active-view").count(), 0);
    heldMethod = TASKS.list;
    await page.getByRole("button", { name: "Retry", exact: true }).click(); await waitHeld(); await assertCold();
    heldMethod = null; release(); await skeleton.waitFor({ state: "hidden" });
    const card = page.locator(".tasks-card:visible").first(); await card.waitFor();
    const title = await card.locator(".tasks-card__title").textContent();
    // Retain a real DOM reference and scroll through held/failed/successful refresh.
    const scroll = await page.evaluate(() => {
      const card = document.querySelector(".tasks-card")!;
      const column = card.closest(".tasks-column")!;
      column.scrollTop = 150;
      (window as any).__loadingCard = card;
      (window as any).__loadingColumn = column;
      return column.scrollTop;
    });
    const stable = async () => {
      assert.equal(await skeleton.count(), 0);
      assert.equal(await page.evaluate(() => (window as any).__loadingCard === document.querySelector(".tasks-card")), true);
      assert.equal(await page.evaluate(() => (window as any).__loadingColumn.scrollTop), scroll);
      assert.equal(await card.locator(".tasks-card__title").textContent(), title);
    };
    heldMethod = TASKS.list; await refresh();
    await waitHeld(); await stable();
    if (width === 390) {
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      assert.equal(await page.getByRole("menuitem", { name: "Refresh board", exact: true }).getAttribute("aria-disabled"), "true");
      await page.keyboard.press("Escape");
    } else assert.equal(await page.getByRole("button", { name: "Refresh board", exact: true }).isDisabled(), true);
    heldMethod = null; release("error");
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".tasks-refresh")?.disabled);
    await stable();
    heldMethod = TASKS.list; await refresh();
    await waitHeld(); await stable(); heldMethod = null; release();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".tasks-refresh")?.disabled);
    await stable(); await page.screenshot({ path: join(out, `loaded-${width}-${theme}.png`) });
    // The same response boundary can represent a genuinely empty first snapshot.
    heldMethod = TASKS.list; await page.reload(); await waitHeld(); await assertCold();
    heldMethod = null; release("empty");
    await page.locator(".tasks-active-view").waitFor();
    assert.equal(await page.locator(".tasks-card").count(), 0);
    assert.ok(await page.getByText("No tasks yet", { exact: true }).count() > 0);
    cases.push({ width, theme, coldCapabilitiesAndList: true, modeSwitch: true, coldFailureRetry: true, cachedRefreshFailureAndSuccess: true, domAndScrollRetained: true, successfulEmpty: true });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  if (service) assert.equal(JSON.stringify(service.handle(TASKS.list, {})), before);
  const version = await fetch(base + "/version.json").then(response => response.json());
  await writeFile(join(out, "receipt.json"), JSON.stringify({ passed: true, version, cases, errors, writes }, null, 2));
  console.log(JSON.stringify({ passed: true, version, cases }));
} finally {
  await browser.close(); await server?.close(); service?.close();
  if (data) await rm(data, { recursive: true, force: true });
}
