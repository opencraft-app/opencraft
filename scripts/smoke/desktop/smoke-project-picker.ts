import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executablePath = process.env.OPENCRAFT_PROJECT_PICKER_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_PROJECT_PICKER_EXECUTABLE to the verified desktop binary");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// macOS AF_UNIX paths are short; keep the isolated daemon endpoint below its limit.
const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oc-picker-"));
const storage = join(directory, "storage"), profile = join(directory, "profile"), root = join(directory, "Example Workspace");
await mkdir(root);
let desktop: any;
const errors: string[] = [];
const launch = async () => {
  desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`],
    env: { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: storage } });
  await desktop.evaluate(() => { (globalThis as any).__name = (value: unknown) => value; });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.locator(".app-shell-root").waitFor();
  const projectTrigger = page.getByRole("button", { name: "Choose project folder" });
  if (!(await projectTrigger.isVisible())) {
    const chat = page.getByRole("button", { name: "Chat", exact: true });
    if (await chat.isVisible()) await chat.click();
    const fresh = page.getByRole("button", { name: /^(New chat|新对话)$/ });
    if (await fresh.isVisible()) await fresh.click();
    else {
      const start = page.getByRole("button", { name: /^(Start|开始)$/ });
      if (await start.isVisible()) await start.click();
    }
  }
  try { await projectTrigger.waitFor(); }
  catch (error) { console.log("DESKTOP_DIAGNOSTIC", page.url(), await page.locator("body").innerText()); throw error; }
  await page.locator('.new-thread-context-trigger .workbench-connection-status[data-phase="ready"]').waitFor({ timeout: 60_000 });
  return page;
};
const addProject = async (page: any) => {
  await page.getByRole("button", { name: "Choose project folder" }).click();
  const item = page.getByRole("menuitem", { name: /^Add project/ });
  assert.equal(await item.getAttribute("data-disabled"), null);
  await item.click();
};
const mockDialog = async (result: { canceled: boolean; filePaths: string[] }, delayed = false) => {
  await desktop.evaluate(({ dialog }: any, input: any) => {
    dialog.showOpenDialog = async (_parent: unknown, options: any) => {
      (globalThis as any).__projectDialogOptions = options;
      ((globalThis as any).__projectDialogCalls ??= []).push(input.result);
      return input.delayed ? new Promise(resolve => { (globalThis as any).__finishProjectDialog = resolve; }) : input.result;
    };
  }, { result, delayed });
};

try {
  let page = await launch();
  if (process.env.OPENCRAFT_NATIVE_PICKER_MANUAL === "1") {
    await addProject(page);
    console.log("NATIVE_DIALOG_OPEN: cancel the real system dialog to continue");
    await page.getByRole("status").filter({ hasText: "Choosing folder…" }).waitFor({ state: "hidden", timeout: 120_000 });
    assert.equal(await page.getByRole("alert").count(), 0);
  }
  await mockDialog({ canceled: true, filePaths: [] });
  console.log("STEP: cancellation");
  const before = await page.locator("[data-new-thread-draft-id]").getAttribute("data-new-thread-draft-id");
  await addProject(page);
  await page.getByRole("status").filter({ hasText: "Choosing folder…" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-new-thread-draft-id]").getAttribute("data-new-thread-draft-id"), before);
  await assert.rejects(readFile(join(storage, "projects.json")), { code: "ENOENT" });

  await mockDialog({ canceled: false, filePaths: [root] });
  console.log("STEP: select directory");
  await addProject(page);
  try {
    await page.getByRole("button", { name: "Choose project folder" }).filter({ hasText: "Example Workspace" }).waitFor();
  } catch (error) {
    console.log("PICKER_DIAGNOSTIC", await desktop.evaluate(() => (globalThis as any).__projectDialogCalls), await page.locator("body").innerText());
    throw error;
  }
  let doc = JSON.parse(await readFile(join(storage, "projects.json"), "utf8"));
  assert.equal(doc.projects.length, 1); assert.deepEqual(doc.projects[0].roots, [{ path: root }]);
  const id = doc.projects[0].id;
  assert.ok(id);
  const options = await desktop.evaluate(() => (globalThis as any).__projectDialogOptions);
  assert.deepEqual(options.properties, ["openDirectory", "createDirectory"]);
  await addProject(page);
  await page.getByRole("status").filter({ hasText: "Choosing folder…" }).waitFor({ state: "hidden" });
  doc = JSON.parse(await readFile(join(storage, "projects.json"), "utf8"));
  assert.equal(doc.projects.length, 1); assert.equal(doc.projects[0].id, id);

  // A picker completing after navigation must not create or retarget a project.
  await mockDialog({ canceled: false, filePaths: [directory] }, true);
  await addProject(page);
  await page.getByRole("status").filter({ hasText: "Choosing folder…" }).waitFor();
  const settings = page.getByRole("button", { name: /^(Settings|设置)$/ });
  if (!await settings.isVisible()) {
    await page.locator('.shell-navigation__entrance[data-surface="applications"]').click();
  }
  await settings.click();
  await desktop.evaluate((_electron: unknown, path: string) => (globalThis as any).__finishProjectDialog({ canceled: false, filePaths: [path] }), directory);
  await page.getByRole("status").filter({ hasText: "Choosing folder…" }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(JSON.parse(await readFile(join(storage, "projects.json"), "utf8")).projects.length, 1);
  await desktop.close(); desktop = undefined;
  page = await launch();
  await page.getByRole("button", { name: "Choose project folder" }).click();
  await page.getByRole("menuitem", { name: /Example Workspace/ }).waitFor();
  assert.equal(JSON.parse(await readFile(join(storage, "projects.json"), "utf8")).projects[0].id, id);
  assert.deepEqual(errors, []);
  console.log("PASS: native capability, cancel, persistence, deduplication, late-selection isolation and restart recovery");
} finally {
  await desktop?.close();
  await rm(directory, { recursive: true, force: true });
}
