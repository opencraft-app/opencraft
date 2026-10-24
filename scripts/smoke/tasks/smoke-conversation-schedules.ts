import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConversationSchedules } from "../../../apps/opencraft-daemon/src/conversation-schedules";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp(join(tmpdir(), "oc-schedules-browser-"));
const artifacts = resolve(process.env.OPENCRAFT_SCHEDULE_ARTIFACTS ?? join(root, "artifacts")); await mkdir(artifacts, { recursive: true });
let submitted = 0, saves = 0, fail = false, held: (() => void) | null = null, hold = false;
const service = new ConversationSchedules(root, {
  validate: async id => { assert.equal(id, "thread"); },
  permissionProfiles: async () => [{ id: "opencraft:permission-mode:full", allowed: true, description: null, openCraftMode: "full", openCraftLabel: "Full access" }],
  submit: async run => { assert.equal(run.permissions, "opencraft:permission-mode:full"); submitted++; return { state: "completed", turnId: "synthetic-turn" }; },
  inspect: async () => ({ state: "completed" }),
});
const source = `
import React from 'react';import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{ConversationTaskMenu}from'/apps/workbench-web/src/components/conversation-task-menu.tsx';
import'/apps/workbench-web/src/styles/app.scss';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
initializeAppearanceTheme();setThemePreference('light');document.documentElement.dataset.uiDensity='touch';window.fixtureTheme=setThemePreference;
const port={request:async(method,params)=>{const response=await fetch('/schedule-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});if(!response.ok)throw Error('Request failed');return response.json()}};
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><ConversationTaskMenu scope="synthetic" serverId="host" threadId="thread" schedules={port} verifyConversation={async()=>{}} onOpenTasks={()=>{}} /></QueryClientProvider>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-schedules-smoke", server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "schedules-smoke", resolveId: id => id === "/schedules-fixture.tsx" ? id : null, load: id => id === "/schedules-fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/schedules-fixture.tsx"></script></body></html>'); return; }
      if (req.url !== "/schedule-rpc") return next();
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
        if (method.endsWith("/save")) saves++;
        if (method.endsWith("/save") && hold) await new Promise<void>(resolve => { held = resolve; });
        if (fail && !method.endsWith("/read")) throw Error("synthetic failure");
        const value = await service.handle(method, params, "fixture-creator"); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
      } catch { res.statusCode = 409; res.end('{}'); }
    }); },
  }] });
let browser: any;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ timezoneId: "Asia/Shanghai", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message)); page.setDefaultTimeout(20000);
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Scheduled task", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Scheduled task", exact: true });
  await panel.getByRole("button", { name: "Create a schedule", exact: true }).click();
  await panel.getByLabel("What should it do?", { exact: true }).fill("Check the synthetic report");
  await panel.getByLabel("Repeat", { exact: true }).selectOption("repeat");
  await panel.getByLabel("Interval in minutes", { exact: true }).fill("60");
  await panel.getByLabel("Permissions", { exact: true }).selectOption("opencraft:permission-mode:full");
  await page.screenshot({ path: join(artifacts, "mobile-create.png") });
  assert.ok(await panel.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1));
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  hold = true; fail = true;
  const capture = () => panel.evaluate((el: HTMLElement) => [...el.querySelectorAll("*")].map((node: HTMLElement) => ({ tag: node.tagName, class: node.className, text: node.textContent?.slice(0, 45), rect: node.getBoundingClientRect().toJSON(), scroll: node.scrollHeight, style: { height: getComputedStyle(node).height, lineHeight: getComputedStyle(node).lineHeight, font: getComputedStyle(node).font, padding: getComputedStyle(node).padding, border: getComputedStyle(node).border, minHeight: getComputedStyle(node).minHeight } })));
  const beforeMetrics = await capture();
  const before = await panel.boundingBox();
  await page.screenshot({path: join(artifacts, "before-submit.png")});
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('form button[type="submit"]')?.hasAttribute('disabled'));
  const during = await panel.boundingBox();
  await writeFile(join(artifacts, "submit-metrics.json"), JSON.stringify({before, during, beforeMetrics, duringMetrics: await capture()}, null, 2));
  await page.screenshot({path: join(artifacts, "during-submit.png")});
  assert.equal(before!.height, during!.height);
  held!(); hold = false;
  await page.getByText("Could not confirm the change. Reload the schedule before trying again.", { exact: true }).waitFor();
  assert.equal(await panel.getByText("Could not confirm the change.", { exact: false }).count(), 0);
  await page.screenshot({ path: join(artifacts, "mobile-error.png") });
  assert.equal(await panel.getByLabel("What should it do?", { exact: true }).inputValue(), "Check the synthetic report");
  fail = false;
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByRole("button", { name: "Pause", exact: true }).waitFor();
  assert.equal(service.read("thread").schedule!.intervalMinutes, 60);
  assert.equal(service.read("thread").schedule!.permissions, "opencraft:permission-mode:full");
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await panel.getByRole("button", { name: "Resume", exact: true }).waitFor();
  assert.equal(service.read("thread").schedule!.status, "paused");
  await panel.getByRole("button", { name: "Resume", exact: true }).click();
  await panel.getByRole("button", { name: "Run now", exact: true }).click();
  await page.waitForTimeout(100); await service.tick(); assert.equal(submitted, 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.uiDensity = "compact"; });
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Conversation actions" }).click(); await page.getByRole("menuitem", { name: "Scheduled task", exact: true }).click();
  await panel.getByText("Recent runs", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "desktop-history.png") });
  await page.evaluate(() => (window as any).fixtureTheme("dark"));
  await page.screenshot({ path: join(artifacts, "desktop-dark.png") });
  assert.notEqual(await panel.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.evaluate(() => (window as any).fixtureTheme("light"));
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await panel.getByLabel("Permissions", { exact: true }).inputValue(), "opencraft:permission-mode:full");
  await panel.getByLabel("What should it do?", { exact: true }).fill("Unsaved user draft");
  await page.waitForTimeout(5200); assert.equal(await panel.getByLabel("What should it do?", { exact: true }).inputValue(), "Unsaved user draft");
  await page.screenshot({ path: join(artifacts, "desktop-edit.png") });
  const edited = service.read("thread").schedule!;
  await service.handle("opencraft/schedules/action", { threadId: "thread", expectedRevision: edited.revision, action: "pause" }, null);
  const conflict = "The schedule changed or has an unfinished run. Cancel editing and review the latest schedule before saving.";
  await panel.getByRole("status").filter({ hasText: conflict }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByLabel("What should it do?", { exact: true }).inputValue(), "Unsaved user draft");
  assert.equal(service.read("thread").schedule!.prompt, edited.prompt);
  await page.screenshot({ path: join(artifacts, "desktop-stale-draft.png") });
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await panel.getByRole("button", { name: "Create a schedule", exact: true }).waitFor();
  assert.equal(service.read("thread").schedule!.status, "deleted");
  // A deleted plan can retain a past/current-minute next run. Opening its form
  // must offer a future date without implicitly recreating the task.
  const deleted = service.read("thread").schedule!;
  await service.handle("opencraft/schedules/save", { threadId: "thread", expectedRevision: deleted.revision, prompt: deleted.prompt,
    nextRunAt: Date.now(), intervalMinutes: 1, timeZone: deleted.timeZone, permissions: deleted.permissions }, null);
  await service.handle("opencraft/schedules/action", { threadId: "thread", expectedRevision: service.read("thread").schedule!.revision, action: "delete" }, null);
  await page.reload();
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Scheduled task", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => { document.documentElement.dataset.uiDensity = "touch"; });
  await panel.getByRole("button", { name: "Create a schedule", exact: true }).click();
  const when = panel.getByLabel("First run", { exact: true });
  const future = await when.inputValue();
  assert.equal(await when.evaluate((input: HTMLInputElement) => new Date(input.value).getTime() > Date.now()), true);
  assert.equal(service.read("thread").schedule!.status, "deleted");
  const savesBeforeInvalid = saves;
  await when.fill("2020-01-01T00:00");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Check the schedule settings and choose a first run in the future.", { exact: true }).waitFor();
  assert.equal(saves, savesBeforeInvalid, "Invalid time never reaches the write port");
  assert.equal(service.read("thread").schedule!.status, "deleted");
  await when.fill(future);
  assert.ok(await panel.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: join(artifacts, "mobile-320.png") });
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByRole("button", { name: "Pause", exact: true }).waitFor();
  assert.equal(service.read("thread").schedule!.intervalMinutes, 1);
  assert.equal(service.read("thread").schedule!.status, "active");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", submitted, mobile: true, desktop: true, toastLayoutStable: true, pollingDraftPreserved: true,
    staleSaveBlocked: true, deletedPlanNotResurrectedOnOpen: true, futureDefault: true, invalidTimeWithoutWrite: true, explicitOneMinuteSave: true, artifacts }));
} finally { held?.(); await browser?.close(); await vite.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
