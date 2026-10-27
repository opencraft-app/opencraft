import assert from "node:assert/strict";
import { mkdtemp, rm, access, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { startHeadlessServer } from "../../headless-server.mjs";

// Exercise the built product, actual AppHost transport and native Codex history.
// Each run has independent storage and no model accounts or real credentials.
const { chromium } = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const packageRoot = process.env.OPENCRAFT_TASKS_WORKBENCH_PACKAGE_ROOT;
const root = packageRoot ?? process.cwd();
const startServer = packageRoot
  ? (await import(pathToFileURL(join(packageRoot, "runtime", process.env.OPENCRAFT_TASKS_WORKBENCH_RUNTIME ?? "server.mjs")).href))
      .startHeadlessServer
  : startHeadlessServer;
const dataDirectory = await mkdtemp(
  join(tmpdir(), "oc-tasks-workbench-smoke-"),
);
let server: Awaited<ReturnType<typeof startHeadlessServer>>;
let browser: any;
let socket: WebSocket | undefined;
let storageSocket: WebSocket | undefined;
let page: any;
try {
  server = await startServer({
    root,
    dataDirectory,
    port: 0,
    webRoot: join(root, packageRoot ? "web" : "apps/workbench-web/dist"),
    dshCapabilityPlugin: join(
      root,
      packageRoot
        ? "runtime/dsh/opencraft-capability-plugin.mjs"
        : "apps/local-agent-host/src/dsh-capability-plugin.mjs",
    ),
    codexExecutable:
      process.env.OPENCRAFT_CODEX_EXECUTABLE ??
      (packageRoot ? join(root, "runtime/codex/bin/codex") : "codex"),
  });
  const url = server.url;
  socket = new WebSocket(`${url.replace(/^http/, "ws")}/apphost`, {
    origin: url,
  });
  const pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  const wait = (id: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${id}`));
      }, 20_000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  socket.on("message", (raw) => {
    const envelope = JSON.parse(raw.toString());
    const frame =
      envelope.type === "host/frame" ? JSON.parse(envelope.frame) : envelope;
    const id =
      envelope.type === "host/frame"
        ? frame.id
        : (envelope.requestId ?? envelope.type);
    const target = pending.get(id);
    if (!target) return;
    pending.delete(id);
    if (frame.error || frame.ok === false)
      target.reject(new Error(JSON.stringify(frame.error)));
    else
      target.resolve(envelope.type === "host/frame" ? frame.result : envelope);
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once("open", resolve);
    socket!.once("error", reject);
  });
  let reply = wait("ready");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 2,
      rendererId: "tasks-workbench-smoke",
    }),
  );
  await reply;
  reply = wait("connect");
  socket.send(
    JSON.stringify({
      type: "host/connect",
      requestId: "connect",
      hostId: "local-codex",
      leaseId: "smoke",
    }),
  );
  const generation = (await reply).result.generation;
  let sequence = 0;
  const rpc = (method: string, params: unknown = {}): Promise<any> => {
    const id = `rpc:${++sequence}`,
      response = wait(id);
    socket!.send(
      JSON.stringify({
        type: "host/send",
        requestId: `send:${id}`,
        hostId: "local-codex",
        leaseId: "smoke",
        generation,
        frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
    return response;
  };
  await rpc("initialize", {
    clientInfo: { name: "tasks-workbench-smoke", version: "1" },
    capabilities: { experimentalApi: true },
  });
  assert.deepEqual(
    (await rpc("opencraft/codex/accounts/list")).accounts,
    [],
    "Smoke must not use a real model account",
  );
  const nativeSkills = await rpc("skills/list", { cwds: [root], forceReload: true });
  assert.ok(nativeSkills.data.some((entry: any) => entry.skills.some((skill: any) => skill.name === "opencraft-tasks")), "Local Codex discovers the global Tasks Skill without a prompt body injection");
  const thread = (await rpc("thread/start", { cwd: root, ephemeral: false }))
    .thread;
  const conversationTitle = "Tasks native integration conversation";
  await rpc("thread/name/set", {
    threadId: thread.id,
    name: conversationTitle,
  });
  // Native Codex only catalogs a thread after its first turn. With no accounts,
  // this persists the user's message and fails locally without paid inference.
  const input = "Tasks integration verification. Do not call tools.";
  const downloadFixtures = [
    { name: "预览 下载.md", bytes: Buffer.from("\ufeff# Original\r\n中文内容\r\n"), label: "Download Markdown fixture" },
    { name: "binary.bin", bytes: Buffer.from([0, 255, 128, 1, 10]), label: "Download binary fixture" },
    { name: "empty.txt", bytes: Buffer.alloc(0), label: "Download empty fixture" },
    { name: "image.png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), label: "Download image fixture" },
    { name: "oversized.txt", bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 65), label: "Download oversized fixture" },
  ];
  for (const fixture of downloadFixtures) {
    await writeFile(join(dataDirectory, fixture.name), fixture.bytes);
  }
  const fixtureLinks = downloadFixtures.map((fixture) =>
    `[${fixture.label}](${pathToFileURL(join(dataDirectory, fixture.name)).href})`,
  ).join("\n\n");
  await rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: `${input}\n\n${fixtureLinks}`, text_elements: [] }],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await rpc("thread/list", { limit: 100, archived: false })).data.some(
        (item: any) => item.id === thread.id,
      )
    )
      break;
    assert.ok(
      attempt < 99,
      "Native thread must be visible in the actual catalog",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cliCatalog = JSON.parse((await promisify(execFile)(process.execPath, [
    join(dataDirectory, "agent/task-agent/opencraft-tasks/scripts/tasks.mjs"),
    "conversations", JSON.stringify({ serverId: "local-codex", search: conversationTitle }),
  ])).stdout);
  assert.ok(cliCatalog.conversations.some((item: any) => item.serverId === "local-codex" && item.threadId === thread.id), "CLI resolves a real native conversation without loading its history");
  const secondThread = (
    await rpc("thread/start", { cwd: root, ephemeral: false })
  ).thread;
  const secondTitle = "Tasks second native conversation";
  await rpc("thread/name/set", {
    threadId: secondThread.id,
    name: secondTitle,
  });
  await rpc("turn/start", {
    threadId: secondThread.id,
    input: [{ type: "text", text: input, text_elements: [] }],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await rpc("thread/list", { limit: 100, archived: false })).data.some(
        (item: any) => item.id === secondThread.id,
      )
    )
      break;
    assert.ok(attempt < 99);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  socket.terminate();
  socket = undefined;

  storageSocket = new WebSocket(`${url.replace(/^http/, "ws")}/appserver`, {
    origin: url,
  });
  await new Promise<void>((resolve, reject) => {
    storageSocket!.once("open", resolve);
    storageSocket!.once("error", reject);
  });
  let directSequence = 0;
  const directRpc = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = `direct:${++directSequence}`;
      const timer = setTimeout(() => {
        storageSocket!.off("message", receive);
        reject(new Error(`Timed out: ${method}`));
      }, 20_000);
      const receive = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(String(raw));
        if (frame.id !== id) return;
        clearTimeout(timer);
        storageSocket!.off("message", receive);
        if (frame.error) reject(frame.error);
        else resolve(frame.result);
      };
      storageSocket!.on("message", receive);
      storageSocket!.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      );
    });
  await directRpc("initialize", {
    clientInfo: { name: "tasks-direct-smoke", version: "1" },
  });
  const project = (
    await directRpc("project/create", {
      name: "Tasks native project",
      roots: [{ path: root }],
      idempotencyKey: "tasks-project",
    })
  ).project;
  const catalog = await directRpc("runtime/providers/list");
  const provider = await directRpc("runtime/providers/apply", {
    target: { kind: "create", id: "tasks-local" },
    expectedRevision: catalog.creation.revision,
    displayName: "Tasks local verification",
    baseURL: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [
      {
        id: "tasks-local",
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
    credential: { kind: "replace", value: "synthetic-local-tasks-key" },
  });
  await directRpc("runtime/providers/setEnabled", {
    provider: "tasks-local",
    enabled: true,
    expectedRevision: provider.revision,
  });
  const dshModel = (await directRpc("model/list")).data.find(
    (model: any) =>
      model.displayName === "tasks-local" ||
      model.model.includes("tasks-local"),
  );
  assert.ok(dshModel);
  const dshThread = (
    await directRpc("thread/start", { cwd: root, model: dshModel.model })
  ).thread;
  await directRpc("thread/name/set", {
    threadId: dshThread.id,
    name: "Tasks DSH conversation",
  });
  const dshSkills = await directRpc("skills/list", { cwds: [root], forceReload: true });
  assert.ok(dshSkills.data.some((entry: any) => entry.skills.some((skill: any) => skill.name === "opencraft-tasks")), "DSH discovers the same global Tasks Skill");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(url);
  assert.equal(
    await page
      .getByRole("button", { name: "Applications", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: /^(Tasks|任务)$/, exact: true }).click();
  await page.waitForURL("**/views/opencraft.tasks.board");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Linked native task");
  await page.locator(".tasks-members summary").click();
  await page.getByLabel("Name", { exact: true }).fill("Alex");
  await page.getByLabel("Member ID (email or employee handle)", { exact: true }).fill("alex@example.test");
  await page.getByRole("button", { name: "Add team member", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('.tasks-editor select[aria-label="Assignee"]') as HTMLSelectElement)?.value === "alex@example.test");
  await page.getByLabel("Priority", { exact: true }).selectOption("high");
  await page.getByLabel("Due date", { exact: true }).fill("2026-12-15");
  await page
    .getByLabel("Project connection", { exact: true })
    .selectOption("opencraft-server");
  await page
    .getByRole("option", { name: "Tasks native project", exact: true })
    .waitFor({ state: "attached" });
  await page
    .locator(".tasks-editor")
    .getByLabel("Project", { exact: true })
    .selectOption(project.id);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('.tasks-editor select[aria-label="Assignee"]') as HTMLSelectElement)?.disabled);
  assert.equal(await page.locator(".tasks-editor").getByLabel("Assignee",{exact:true}).inputValue(),"alex@example.test");
  await page.getByLabel("Conversation connection", { exact: true }).waitFor();
  await page
    .getByLabel("Conversation connection", { exact: true })
    .selectOption("local-codex");
  await page
    .getByRole("option", { name: conversationTitle, exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Select conversation", { exact: true })
    .selectOption(thread.id);
  await page
    .getByRole("button", { name: "Link conversation", exact: true })
    .click();
  await page
    .locator(".tasks-link")
    .getByText(conversationTitle, { exact: false })
    .waitFor();
  await page
    .getByRole("option", { name: secondTitle, exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Select conversation", { exact: true })
    .selectOption(secondThread.id);
  await page
    .getByRole("button", { name: "Link conversation", exact: true })
    .click();
  await page
    .locator(".tasks-link")
    .getByText(secondTitle, { exact: false })
    .waitFor();
  await page
    .getByLabel("Conversation connection", { exact: true })
    .selectOption("opencraft-server");
  await page
    .getByRole("option", { name: "Tasks DSH conversation", exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Select conversation", { exact: true })
    .selectOption(dshThread.id);
  await page
    .getByRole("button", { name: "Link conversation", exact: true })
    .click();
  await page
    .locator(".tasks-link")
    .getByText("Tasks DSH conversation", { exact: false })
    .waitFor();

  await page
    .locator('.tasks-editor').getByLabel("Task status", { exact: true })
    .selectOption("in_progress");
  await page.waitForFunction(() => !(document.querySelector('.tasks-editor select[aria-label="Task status"]') as HTMLSelectElement)?.disabled);
  assert.equal(await page.getByRole("dialog", { name: "Task details", exact: true }).count(), 1, "Task details use the shared modal while retaining the board");
  await page.screenshot({ path: "/tmp/opencraft-tasks-detail-desktop.png" });
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("New task"));
  assert.equal(await page.locator('.tasks-card select').count(), 0, "Board cards keep editing controls in details");
  assert.equal(await page.locator('.tasks-card__conversation').count(), 1, "Cards have one direct conversation shortcut");
  const card = () =>
    page
      .getByRole("region", { name: "In progress", exact: true })
      .getByRole("button", { name: "Linked native task", exact: true });
  if (await page.locator(".tasks-statuses").isVisible()) await page.locator(".tasks-statuses").getByRole("radio", { name: /^In progress/ }).click();
  await card().waitFor();
  await page.getByRole("radio", { name: "List", exact: true }).click();
  assert.equal(await page.locator('.tasks-list .tasks-card').count(), 0, "List uses dedicated rows");
  await page.getByLabel("Move to: Linked native task", { exact: true }).selectOption("in_review");
  await page.waitForFunction(() => !(document.querySelector('.tasks-row select') as HTMLSelectElement)?.disabled);
  await page.getByLabel("Move to: Linked native task", { exact: true }).selectOption("in_progress");
  await page.waitForFunction(() => !(document.querySelector('.tasks-row select') as HTMLSelectElement)?.disabled);
  await page.screenshot({ path: "/tmp/opencraft-tasks-list-desktop.png" });
  await page
    .locator(".tasks-list")
    .getByRole("button", { name: "Linked native task", exact: true })
    .click();
  await page
    .locator(".tasks-link")
    .filter({ hasText: conversationTitle })
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await page.waitForURL(`**/local/${thread.id}?hostId=local-codex`);
  await page.getByText(input, { exact: true }).waitFor();
  for (const fixture of downloadFixtures) {
    await page.getByRole("link", { name: fixture.label, exact: true }).click();
    const preview = page.locator(".workspace-file-viewer");
    await preview.locator("strong").getByText(fixture.name, { exact: true }).waitFor();
    const downloadLink = preview.getByRole("link", { name: "Download file", exact: true });
    await page.waitForFunction(() => document.querySelector('.workspace-file-viewer a[download]')?.getAttribute("href")?.startsWith("blob:"));
    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), fixture.name);
    assert.deepEqual(await readFile(await download.path()), fixture.bytes);
    if (fixture.name.endsWith(".md")) {
      await preview.screenshot({ path: "/tmp/opencraft-preview-download-desktop.png" });
      await preview.getByRole("button", { name: "Source", exact: true }).click();
      const sourceDownloadPromise = page.waitForEvent("download");
      await downloadLink.click();
      assert.deepEqual(await readFile(await (await sourceDownloadPromise).path()), fixture.bytes);
    }
  }
  const mobileDownloadPage = await browser.newPage({
    viewport: { width: 390, height: 720 }, hasTouch: true, isMobile: true,
  });
  mobileDownloadPage.on("pageerror", (error: Error) => errors.push(error.message));
  await mobileDownloadPage.goto(`${url}/local/${thread.id}?hostId=local-codex`);
  await mobileDownloadPage.getByRole("link", { name: downloadFixtures[0].label, exact: true }).click();
  const mobilePreview = mobileDownloadPage.locator(".workspace-file-viewer");
  await mobilePreview.locator("strong").getByText(downloadFixtures[0].name, { exact: true }).waitFor();
  const mobileSidebar = mobileDownloadPage.getByRole("button", { name: "Hide sidebar", exact: true }).filter({ visible: true }).first();
  if (await mobileSidebar.isVisible()) await mobileSidebar.click();
  const maximizeMobilePreview = mobileDownloadPage.getByRole("button", { name: "Maximize panel", exact: true });
  if (await maximizeMobilePreview.isVisible()) await maximizeMobilePreview.click();
  const treeToggle = mobilePreview.locator(".workspace-file-tree-toggle[aria-expanded=true]");
  if (await treeToggle.isVisible()) await treeToggle.click();
  const mobileDownloadLink = mobilePreview.getByRole("link", { name: "Download file", exact: true });
  await mobileDownloadPage.waitForFunction(() => document.querySelector('.workspace-file-viewer a[download]')?.getAttribute("href")?.startsWith("blob:"));
  await mobileDownloadPage.waitForFunction(() => {
    const bounds = document.querySelector('.workspace-file-viewer a[download]')?.getBoundingClientRect();
    return bounds && bounds.x >= 0 && bounds.right <= innerWidth;
  });
  const downloadBounds = await mobileDownloadLink.boundingBox();
  const siblingActionBounds = await mobilePreview.getByRole("button", { name: "Source", exact: true }).boundingBox();
  assert.equal(downloadBounds.height, siblingActionBounds.height);
  assert.ok(downloadBounds.x >= 0 && downloadBounds.x + downloadBounds.width <= 390);
  assert.ok(await mobileDownloadPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobilePreview.screenshot({ path: "/tmp/opencraft-preview-download-mobile.png" });
  const mobileDownloadPromise = mobileDownloadPage.waitForEvent("download");
  await mobileDownloadLink.click();
  const mobileDownload = await mobileDownloadPromise;
  assert.equal(mobileDownload.suggestedFilename(), downloadFixtures[0].name);
  assert.deepEqual(await readFile(await mobileDownload.path()), downloadFixtures[0].bytes);
  await mobileDownloadPage.close();
  console.log("Preview downloads: Unicode names, original Markdown bytes, binary, empty, image and oversized files verified.");
  await page.goBack();
  await page.locator(".tasks-editor").waitFor();
  await page
    .getByRole("button", { name: "Close task details", exact: true })
    .click();
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  if (await page.locator(".tasks-statuses").isVisible()) await page.locator(".tasks-statuses").getByRole("radio", { name: /^In progress/ }).click();
  await card().waitFor();
  await page.reload();
  await page.locator(".tasks-viewport").waitFor();
  const reloadedStatus = page.getByRole("radio", { name: "In progress 1", exact: true });
  if (await reloadedStatus.isVisible()) await reloadedStatus.click();
  if (await page.locator(".tasks-statuses").isVisible()) await page.locator(".tasks-statuses").getByRole("radio", { name: /^In progress/ }).click();
  await card().waitFor();
  // A second actual client updates the same Tasks authority while an editor has a draft.
  const second = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await second.goto(url);
  await second.getByRole("button", { name: /^(Tasks|任务)$/, exact: true }).click();
  const secondStatus = second.getByRole("radio", { name: "In progress 1", exact: true });
  if (await secondStatus.isVisible()) await secondStatus.click();
  await second
    .getByRole("button", { name: "Linked native task", exact: true })
    .click();
  await card().click();
  await page.getByLabel("Title", { exact: true }).fill("Retained local draft");
  await second
    .getByLabel("Description", { exact: true })
    .fill("Updated by another client");
  await second.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("button", { name: "Load latest content", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Retained local draft",
  );
  assert.equal(
    await page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Load latest content", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Description", { exact: true }).inputValue(),
    "Updated by another client",
  );
  await second.close();
  await page
    .getByRole("button", { name: "Close task details", exact: true })
    .click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Second task sharing a conversation");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByLabel("Conversation connection", { exact: true })
    .selectOption("local-codex");
  await page
    .getByRole("option", { name: conversationTitle, exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("Select conversation", { exact: true })
    .selectOption(thread.id);
  await page
    .getByRole("button", { name: "Link conversation", exact: true })
    .click();
  await page.locator(".tasks-link").waitFor();
  await page
    .getByRole("button", { name: "Close task details", exact: true })
    .click();
  const filter = page
    .locator(".tasks-toolbar")
    .getByLabel("Project", { exact: true });
  await page
    .locator(".tasks-toolbar option")
    .filter({ hasText: "Tasks native project" })
    .waitFor({ state: "attached" });
  await filter.selectOption(JSON.stringify(["opencraft-server", project.id]));
  assert.equal(await page.locator("[data-task-id]").count(), 1);
  await filter.selectOption("");
  assert.equal(await page.locator("[data-task-id]").count(), 2);
  // Phone layout preserves the same records and gives the editor a full container.
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).filter({ visible: true }).first().click();
  await page.setViewportSize({ width: 390, height: 720 });
  await page.getByRole("radio", { name: "List", exact: true }).click();
  assert.equal(await page.locator('.tasks-row').count(), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "/tmp/opencraft-tasks-list-mobile.png" });
  await page.getByRole("radio", { name: "Board", exact: true }).click();
  await page.getByRole("radio", { name: "In progress 1", exact: true }).click();
  await card().click();
  await page.getByLabel("Title", { exact: true }).fill("Mobile draft retained");
  const mobileContent = await page.locator('.tasks-editor__content').boundingBox();
  const mobileProperties = await page.locator('.tasks-editor__properties').boundingBox();
  assert.ok(mobileContent && mobileProperties && mobileProperties.y > mobileContent.y && mobileProperties.x >= mobileContent.x, "Phone properties remain below the title within the content");
  assert.equal(await page.locator('.tasks-editor__tabs').isVisible(), true, "Phone activity uses tabs without remounting the draft");
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "Mobile draft retained");
  const desktopContent = await page.locator('.tasks-editor__content').boundingBox();
  const desktopProperties = await page.locator('.tasks-editor__properties').boundingBox();
  const desktopActivity = await page.locator(".tasks-activity").boundingBox();
  assert.ok(desktopContent && desktopProperties && desktopActivity && desktopActivity.x >= desktopContent.x + desktopContent.width, "Wide details keep activity beside the content and inline properties");
  await page.setViewportSize({ width: 390, height: 720 });
  await page.waitForTimeout(5200);
  await page.screenshot({ path: "/tmp/opencraft-tasks-detail-mobile.png" });
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Mobile draft retained",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  if (process.env.OPENCRAFT_TASKS_SCREENSHOT)
    await page.screenshot({ path: process.env.OPENCRAFT_TASKS_SCREENSHOT });
  await page
    .getByRole("button", { name: "Close task details", exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 900 });
  // Open the already-linked DSH thread through its native Tasks action. This
  // verifies the storage authority across Servers without an obsolete global
  // engine picker (the current picker selects machines).
  await card().click();
  await page.locator(".tasks-link").filter({ hasText: "Tasks DSH conversation" }).getByRole("button", { name: "Open conversation", exact: true }).click();
  await page.waitForFunction(
    () =>
      new URL(location.href).searchParams.get("hostId") === "opencraft-server",
  );
  const returnSidebar = page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first();
  if (await returnSidebar.isVisible()) await returnSidebar.click();
  await page.getByRole("button", { name: /^(Tasks|任务)$/, exact: true }).click();
  await page.locator(".tasks-dialog").waitFor();
  assert.equal(await page.getByLabel("Title", {exact:true}).inputValue(), "Mobile draft retained");
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  if (await page.locator(".tasks-statuses").isVisible()) await page.locator(".tasks-statuses").getByRole("radio", { name: /^In progress/ }).click();
  await card().waitFor();
  const db = new DatabaseSync(join(dataDirectory, "agent/tasks.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM tasks WHERE deleted_at IS NULL")
        .get()?.n,
      2,
    );
    const row = db
      .prepare(
        "SELECT server_id,thread_id FROM task_conversations WHERE thread_id=?",
      )
      .get(thread.id);
    assert.equal(row?.server_id, "local-codex");
    assert.equal(row?.thread_id, thread.id);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM task_conversations").get()?.n,
      4,
    );
    assert.equal(
      db
        .prepare("SELECT status FROM tasks WHERE title=?")
        .get("Linked native task")?.status,
      "in_progress",
    );
  } finally {
    db.close();
  }
  await assert.rejects(access(join(dataDirectory, "codex/tasks.sqlite")), {
    code: "ENOENT",
  });
  const taskId = (
    await directRpc("opencraft/tasks/conversations/tasks", {
      serverId: "local-codex",
      threadId: thread.id,
    })
  ).tasks.find((task: any) => task.title === "Linked native task").id;
  const linked = await directRpc("opencraft/tasks/read", { id: taskId });
  assert.equal(linked.conversations.length, 3);
  assert.equal(linked.projectId, project.id);
  assert.equal(linked.projectServerId, "opencraft-server");
  await directRpc("opencraft/tasks/conversations/detach", {
    id: taskId,
    expectedRevision: linked.revision,
    serverId: "opencraft-server",
    threadId: dshThread.id,
  });
  assert.equal(
    (
      await directRpc("thread/read", {
        threadId: dshThread.id,
        includeTurns: false,
      })
    ).thread.id,
    dshThread.id,
    "Unlinking does not delete the native conversation",
  );
  // The user's actual workflow: save-and-open a native draft, reload it,
  // explicitly send, and link the confirmed thread even if inference fails.
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Task to native chat");
  await page.getByLabel("Description", { exact: true }).fill("Explicit first turn from a task. Do not call tools.");
  await page.getByLabel("Project connection", { exact: true }).selectOption("opencraft-server");
  await page.getByRole("option", { name: "Tasks native project", exact: true }).waitFor({ state: "attached" });
  await page.locator('.tasks-editor').getByLabel("Project", { exact: true }).selectOption(project.id);
  await page.getByLabel("Execution connection", { exact: true }).selectOption("local-codex");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.waitForURL((value: URL) => !value.pathname.startsWith("/views/"));
  const editor = page.locator('.opencraft-composer-editor[role="textbox"]:visible');
  await editor.waitFor();
  assert.match(await editor.innerText(), /Task to native chat/);
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('opencraft.draft.v1.') && localStorage.getItem(key)?.includes('Task to native chat')));
  const crossServerTarget = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('opencraft.draft.v1.') && localStorage.getItem(key)?.includes('Task to native chat'))!;
    return JSON.parse(localStorage.getItem(key)!).target;
  });
  assert.equal(crossServerTarget.execution.hostId, 'local-codex');
  assert.equal(crossServerTarget.execution.workspace.projectId, undefined, 'Cross-Server task projects must not redirect execution');
  let flowTask = (await directRpc("opencraft/tasks/list")).tasks.find((task: any) => task.title === "Task to native chat");
  assert.equal(flowTask.conversations.length, 0, "Opening a draft never creates a thread or sends a Turn");
  await page.reload();
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelector('.opencraft-composer-editor')?.textContent?.includes('Explicit first turn from a task'));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt++) {
    flowTask = await directRpc("opencraft/tasks/read", { id: flowTask.id });
    if (flowTask.conversations.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(flowTask.conversations.length, 1);
  assert.equal(flowTask.conversations[0].serverId, "local-codex");
  const flowThreadId = flowTask.conversations[0].threadId;
  await page.getByRole("button", { name: /^(Tasks|任务)$/, exact: true }).click();
  await page.getByRole("button", { name: "Task to native chat", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("Unsaved description retained across status change");
  await page.locator('.tasks-editor').getByLabel("Task status", { exact: true }).selectOption("in_review");
  await page.waitForFunction(() => {
    const select = document.querySelector('.tasks-editor select[aria-label="Task status"]') as HTMLSelectElement | null;
    return select?.value === 'in_review' && !select.disabled;
  });
  assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), "Unsaved description retained across status change");
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  const flowCard = page.locator('[data-task-id]').filter({ has: page.getByRole("button", { name: "Task to native chat", exact: true }) });
  await flowCard.locator('.tasks-card__conversation').click();
  await page.waitForURL(`**/local/${flowThreadId}?hostId=local-codex`);
  // Conversation-owned menu uses the fixed Tasks database, even on local-codex.
  const actions = page.getByRole("button", { name: "Conversation actions", exact: true });
  await actions.waitFor();
  const actionsBox = await actions.boundingBox();
  const panelBox = await page.locator('.app-shell-header__end-slot .app-shell-header__right-panel-toggle').boundingBox();
  assert.ok(actionsBox && panelBox && actionsBox.x + actionsBox.width <= panelBox.x + 1, 'Conversation menu precedes the panel toggle');
  const linkTasks = page.getByRole("button", { name: "Link tasks", exact: true });
  const linkBox = await linkTasks.boundingBox();
  assert.ok(linkBox && actionsBox && linkBox.x + linkBox.width <= actionsBox.x + 1, "Link tasks is directly left of conversation actions");
  await actions.click();
  assert.equal(await page.getByRole("menuitem", { name: "Link tasks", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  const membership = page.getByRole("dialog", { name: "Link tasks", exact: true });
  const openMembership = async () => {
    if (await linkTasks.isVisible()) await linkTasks.click();
    else {
      await actions.click();
      await page.getByRole("menuitem", { name: "Link tasks", exact: true }).click();
    }
    await membership.getByRole("switch", { name: flowTask.title, exact: true }).waitFor();
  };
  await openMembership();
  assert.equal(await membership.getByRole("switch", { name: flowTask.title, exact: true }).getAttribute('aria-checked'), 'true');
  const otherTask = (await directRpc("opencraft/tasks/list")).tasks.find((task: any) => task.id !== flowTask.id);
  const otherSwitch = membership.getByRole("switch", { name: otherTask.title, exact: true });
  await otherSwitch.click();
  await page.waitForFunction(title => document.querySelector(`[role="switch"][aria-label="${title}"]`)?.getAttribute('aria-checked') === 'true', otherTask.title);
  assert.equal((await directRpc("opencraft/tasks/conversations/tasks", { serverId: 'local-codex', threadId: flowThreadId })).tasks.length, 2);
  await membership.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await openMembership();
  assert.equal(await otherSwitch.getAttribute('aria-checked'), 'true');
  await otherSwitch.click();
  await page.waitForFunction(title => document.querySelector(`[role="switch"][aria-label="${title}"]`)?.getAttribute('aria-checked') === 'false', otherTask.title);
  assert.equal((await directRpc("opencraft/tasks/conversations/tasks", { serverId: 'local-codex', threadId: flowThreadId })).tasks.length, 1);
  // The next successful attach must verify the same native thread through the
  // renderer's live AppHost lease; the initial fixture socket is already closed.
  const concurrent = await directRpc('opencraft/tasks/read', { id: otherTask.id });
  await directRpc('opencraft/tasks/update', {
    id: concurrent.id, expectedRevision: concurrent.revision, title: concurrent.title,
    description: 'Concurrent task edit retained by membership picker',
    projectServerId: concurrent.projectServerId, projectId: concurrent.projectId,
  });
  await page.evaluate(() => {
    const original = WebSocket.prototype.send;
    (window as any).__membershipAttachWrites = 0;
    (window as any).__membershipRestoreSend = () => { WebSocket.prototype.send = original; };
    WebSocket.prototype.send = function(data) {
      if (typeof data === "string" && data.includes("opencraft/tasks/conversations/attach")) (window as any).__membershipAttachWrites++;
      return original.call(this, data);
    };
  });
  await otherSwitch.click();
  // A notification may have refreshed the revision before this click. Both a
  // current-revision success and an explicit CAS error are legitimate; neither
  // may silently replay a stale write.
  await page.waitForFunction(title => document.querySelector(`[role="switch"][aria-label="${title}"]`)?.getAttribute('aria-checked') === 'true' || document.body.textContent?.includes('Could not confirm the change. Review the current selection and retry.'), otherTask.title);
  assert.equal(await page.evaluate(() => (window as any).__membershipAttachWrites), 1, 'One explicit click sends one attach, including the concurrent-edit case');
  await page.evaluate(() => (window as any).__membershipRestoreSend());
  if (await otherSwitch.getAttribute('aria-checked') === 'false') await otherSwitch.click();
  await page.waitForFunction(title => document.querySelector(`[role="switch"][aria-label="${title}"]`)?.getAttribute('aria-checked') === 'true', otherTask.title);
  assert.equal((await directRpc('opencraft/tasks/read', { id: otherTask.id })).description, 'Concurrent task edit retained by membership picker');
  await otherSwitch.click();
  await page.waitForFunction(title => document.querySelector(`[role="switch"][aria-label="${title}"]`)?.getAttribute('aria-checked') === 'false', otherTask.title);
  await membership.getByLabel('Search tasks', { exact: true }).fill('No such task in this independent fixture');
  await membership.getByText('No matching tasks.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await linkTasks.evaluate((element: HTMLElement) => element === document.activeElement), true, 'Dialog restores focus to the task-link button');
  await page.setViewportSize({ width: 390, height: 720 });
  await linkTasks.waitFor({ state: "hidden" });
  await openMembership();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await membership.screenshot({ path: process.env.OPENCRAFT_TASKS_MEMBERSHIP_SCREENSHOT ?? '/tmp/opencraft-tasks-membership-mobile.png' });
  await membership.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await actions.evaluate((element: HTMLElement) => element === document.activeElement), true, 'Mobile picker restores focus to overflow');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goBack();
  await page.reload();
  flowTask = await directRpc("opencraft/tasks/read", { id: flowTask.id });
  assert.equal(flowTask.status, "in_review");
  assert.equal(flowTask.conversations.length, 1);
  // Existing-conversation association is also available before the first save.
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Link without a separate save");
  await page.getByLabel("Conversation connection", { exact: true }).selectOption("local-codex");
  await page.getByRole("option", { name: conversationTitle, exact: true }).waitFor({ state: "attached" });
  await page.getByLabel("Select conversation", { exact: true }).selectOption(thread.id);
  await page.getByRole("button", { name: "Link conversation", exact: true }).click();
  await page.locator('.tasks-link').getByText(conversationTitle, { exact: false }).waitFor();
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 720 });
  await page.getByRole("radio", { name: "In review 1", exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('.tasks-viewport').screenshot({ path: process.env.OPENCRAFT_TASKS_FLOW_SCREENSHOT ?? '/tmp/opencraft-tasks-flow-mobile.png' });
  // Same-Server project selection reaches the real native draft placement.
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Project task draft handoff");
  await page.getByLabel("Project connection", { exact: true }).selectOption("opencraft-server");
  await page.getByRole("option", { name: "Tasks native project", exact: true }).waitFor({ state: "attached" });
  await page.locator('.tasks-editor').getByLabel("Project", { exact: true }).selectOption(project.id);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await editor.waitFor();
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('opencraft.draft.v1.') && localStorage.getItem(key)?.includes('Project task draft handoff')));
  const sameServerTarget = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('opencraft.draft.v1.') && localStorage.getItem(key)?.includes('Project task draft handoff'))!;
    return JSON.parse(localStorage.getItem(key)!).target;
  });
  assert.equal(sameServerTarget.execution.hostId, 'opencraft-server');
  assert.equal(sameServerTarget.execution.workspace.projectId, project.id);
  assert.equal(sameServerTarget.execution.workspace.cwd, root);
  // The header consumes the same native title/pin owners as sidebar actions.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${url}/local/${flowThreadId}?hostId=local-codex`);
  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename conversation", exact: true });
  await renameDialog.getByLabel("Conversation name", { exact: true }).fill("Renamed from header");
  await renameDialog.getByRole("button", { name: "Save", exact: true }).click();
  await renameDialog.waitFor({ state: "hidden" });
  await page.locator('.thread-header-copy strong').getByText("Renamed from header", { exact: true }).waitFor();
  await page.reload();
  await page.locator('.thread-header-copy strong').getByText("Renamed from header", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/opencraft-conversation-header-menu-desktop.png" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 720 });
  await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/opencraft-conversation-header-menu-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Full Workbench Tasks smoke passed: native conversations, shared list/board, many-to-many links, conflicts, mobile layout, router POP, fixed SQLite authority, task-to-native-draft prefill/reload/send/receipt association, same/cross-Server project placement, detail status with retained edits, direct-card conversation routes and conversation-header task membership/search/reload/unlink/focus/mobile.",
  );
} catch (error) {
  if (page) { await page.screenshot({path:"/tmp/opencraft-tasks-failure.png"}); console.error(await page.locator("body").innerText()); }
  throw error;
} finally {
  socket?.terminate();
  storageSocket?.terminate();
  await browser?.close();
  await server!?.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
