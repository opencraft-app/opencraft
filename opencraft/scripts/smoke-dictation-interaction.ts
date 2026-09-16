import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { connectFixtureAppHost } from "./fixtures/app-host-client.js";

const executablePath = process.env.OPENCRAFT_NATIVE_SPEECH_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_NATIVE_SPEECH_EXECUTABLE to the verified signed desktop");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const directory = await mkdtemp("/tmp/oc-dictation-ui-");
const requests: string[] = [];
const taskRequests = () => requests.filter(raw => JSON.parse(raw).some((message: any) => message.role === "user" && message.content === "Native fixture transcript"));
const endpoint = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(JSON.stringify(body.messages));
  res.setHeader("content-type", "text/event-stream");
  const packet = (delta: any, finish: string | null) => `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.end(packet({ role: "assistant", content: "Dictation UI verified" }, null) + packet({}, "stop") + "data: [DONE]\n\n");
});
let desktop: any, page: any;
try {
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const port = (endpoint.address() as { port: number }).port;
  const launchOptions = { executablePath, args: [`--user-data-dir=${join(directory, "profile")}`], env: {
    ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(directory, "models"), OPENCRAFT_NATIVE_SPEECH_HELPER: resolve("scripts/fixtures/native-speech-helper.cjs"),
  } };
  desktop = await _electron.launch(launchOptions);
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.locator('.workbench-connection-status[data-phase="ready"]').first().waitFor({ state: "attached" });
  let request = await connectFixtureAppHost(page);
  const providers = await request("runtime/providers/list");
  const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "dictation-fixture" }, expectedRevision: providers.creation.revision,
    displayName: "Dictation fixture", baseURL: `http://127.0.0.1:${port}/v1`, api: "openai-completions",
    models: [{ id: "dictation-fixture", input: ["text"], contextWindow: 8192, maxTokens: 1024 }], credential: { kind: "replace", value: "synthetic-local-key" } });
  await request("runtime/providers/setEnabled", { provider: "dictation-fixture", enabled: true, expectedRevision: saved.revision });
  const settings = await request("runtime/settings/describe"), ns = settings.namespaces.find((entry: any) => entry.ns === "agent-default-model");
  await request("runtime/settings/mutate", { ns: ns.ns, expectedRevision: ns.revision, ops: [
    { op: "set", path: ["provider"], value: "dictation-fixture" }, { op: "set", path: ["model"], value: "dictation-fixture" },
  ] });
  // Configuration is diagnostic setup, not a UI model-refresh acceptance test.
  // Cold launch exercises the actual product-owned persisted catalog projection.
  await desktop.close(); desktop = await _electron.launch(launchOptions);
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.locator('.workbench-connection-status[data-phase="ready"]').first().waitFor({ state: "attached" });
  request = await connectFixtureAppHost(page);
  const coldModels = await request("model/list");
  console.log("COLD_CATALOG", { modelCount: coldModels.data.length, defaults: coldModels.data.filter((entry: any) => entry.isDefault).length });
  await page.getByRole("button", { name: "Chat", exact: true }).first().click();
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  try { await page.waitForFunction(() => document.querySelector(".codex-composer-mode--intelligence")?.getAttribute("title")?.startsWith("dictation-fixture")); }
  catch (error) { console.log("MODEL_PICKER_DIAGNOSTIC", await page.locator(".codex-composer-mode--intelligence").getAttribute("title")); throw error; }
  const mic = page.locator(".opencraft-voice-input-action"), editor = page.locator(".ProseMirror").first();
  const original = "Existing typed text. ";
  await editor.fill(original);
  await page.evaluate(() => { (window as any).__dictationEditor = document.querySelector(".ProseMirror"); });
  const start = async () => {
    const before = await editor.textContent();
    await mic.click(); await page.locator('.codex-composer-voice-footer[data-voice-phase="listening"]').waitFor();
    assert.equal(await editor.textContent(), before); assert.equal(await page.locator("[data-transient-text]").count(), 0);
    assert.equal(await editor.getAttribute("contenteditable"), "false");
  };
  await start();
  assert.equal(await page.locator('.codex-composer-footer__end[inert][aria-hidden="true"]').count(), 1);
  assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).count(), 0);
  await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
  await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  const committed = original + "Native fixture transcript";
  assert.equal(await editor.textContent(), committed); assert.equal(requests.length, 0);
  assert.equal(await page.evaluate(() => (window as any).__dictationEditor === document.querySelector(".ProseMirror")), true);
  await start(); await page.keyboard.press("Escape");
  await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  assert.equal(await editor.textContent(), committed);
  await start(); await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  assert.equal(await editor.textContent(), committed); assert.equal(requests.length, 0);
  console.log("PASS insert, Escape, processing-cancel and physical editor identity");
  const microphoneBounds = await mic.boundingBox();
  await page.mouse.move(microphoneBounds!.x + microphoneBounds!.width / 2, microphoneBounds!.y + microphoneBounds!.height / 2);
  await page.mouse.down(); await page.locator('.codex-composer-voice-footer[data-voice-phase="listening"]').waitFor();
  await page.mouse.up(); await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  assert.equal((await editor.textContent())?.match(/Native fixture transcript/g)?.length, 2);
  assert.equal(requests.length, 0); console.log("PASS real pointer hold/release writes once without a second click session");
  await editor.fill("");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).first().click();
  await start();
  await desktop.evaluate(({ BrowserWindow }: any) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.screenshot({ path: "/tmp/opencraft-dictation-dark.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).first().click();
  await start();
  await desktop.evaluate(({ BrowserWindow }: any) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(760, 800); window.show(); window.focus(); });
  const bounds = await page.locator(".codex-composer-voice-footer").evaluate((footer: HTMLElement) => {
    const outer = footer.getBoundingClientRect(); return [...footer.querySelectorAll("button, canvas")].every(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= outer.left - 1 && rect.right <= outer.right + 1;
    });
  }); assert.equal(bounds, true);
  await page.screenshot({ path: "/tmp/opencraft-dictation-light.png" });
  await page.keyboard.press("Enter");
  assert.equal(requests.length, 0); // Do not send provisional text before the final callback.
  await page.getByText("Dictation UI verified", { exact: true }).first().waitFor();
  console.log("INFERENCE_SHAPES", requests.map(raw => {
    const messages = JSON.parse(raw);
    return { roles: messages.map((message: any) => message.role), lengths: messages.map((message: any) => JSON.stringify(message.content).length),
      exactUser: messages.some((message: any) => message.role === "user" && message.content === "Native fixture transcript"),
      titleSystem: messages.some((message: any) => message.role === "system" && /title|标题/i.test(JSON.stringify(message.content))) };
  }));
  assert.equal(taskRequests().length, 1); assert.equal((taskRequests()[0]!.match(/Native fixture transcript/g) ?? []).length, 1);
  console.log("PASS final recognition precedes Enter/send compilation; one turn request (DSH may separately generate its title), no duplicate transcript");
  await start();
  await page.getByRole("button", { name: "识别完成后发送", exact: true }).click();
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  await request("model/list"); assert.equal(taskRequests().length, 1);
  await start(); await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
  assert.equal((await editor.textContent())?.includes("Late canceled"), false);
  assert.equal(taskRequests().length, 1); assert.deepEqual(errors, []);
  console.log("PASS dark/light, narrow geometry, canceled-send and draft replacement; synthetic OS boundary and local DSH inference only; no microphone capture");
} catch (error) {
  try { await page?.screenshot({ path: "/tmp/opencraft-dictation-failure.png" }); } catch {}
  throw error;
} finally {
  await desktop?.close(); await new Promise<void>(resolve => endpoint.close(() => resolve())); await rm(directory, { recursive: true, force: true });
}
