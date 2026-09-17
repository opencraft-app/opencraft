import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const executablePath = process.env.OPENCRAFT_NATIVE_SPEECH_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_NATIVE_SPEECH_EXECUTABLE to the verified desktop binary");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const directory = await mkdtemp("/tmp/oc-native-speech-");
let desktop: any;
const errors: string[] = [];
async function launch(synthetic: boolean) {
  const env = { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(directory, "models") };
  delete env.OPENCRAFT_NATIVE_SPEECH_HELPER;
  if (synthetic) env.OPENCRAFT_NATIVE_SPEECH_HELPER = resolve("scripts/fixtures/native-speech-helper.cjs");
  desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${join(directory, "profile")}`], env });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.locator(".app-shell-root").waitFor();
  await page.locator('.workbench-connection-status[data-phase="ready"]').first().waitFor({ state: "attached" });
  await page.evaluate("window.__name=value=>value");
  return page;
}
try {
  let page = await launch(false);
  const probe = await page.evaluate(async () => {
    const info = await (window as any).opencraftDesktop.speech.probe("en-US");
    return { supported: info.supported, available: info.available, authorization: info.authorization,
      supportsOnDeviceRecognition: info.supportsOnDeviceRecognition, deviceCount: info.devices.length };
  });
  assert.equal(probe.supported, true);
  assert.equal(typeof probe.supportsOnDeviceRecognition, "boolean");
  console.log("NATIVE_NO_CAPTURE_PROBE", probe);
  await desktop.close(); desktop = undefined;
  page = await launch(true);
  console.log("SYNTHETIC_DESKTOP_READY");
  await page.waitForFunction(() => document.querySelector(".codex-composer-mode__model-label")?.textContent?.trim() === "Model");
  const voice = page.locator(".opencraft-voice-input-action");
  const microphone = voice;
  const cancel = page.getByRole("button", { name: "取消语音输入", exact: true });
  const editor = page.locator(".ProseMirror").first();
  const original = "Existing typed text. ";
  await editor.fill(original);
  await microphone.click();
  await page.locator('.codex-composer-voice-footer[data-voice-phase="listening"]').waitFor();
  assert.equal(await editor.textContent(), original);
  assert.equal(await page.locator("[data-transient-text]").count(), 0);
  assert.equal(await editor.getAttribute("contenteditable"), "false");
  await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
  await cancel.waitFor({ state: "hidden" });
  console.log("SYNTHETIC_FINAL_COMMITTED");
  const committed = original + "Native fixture transcript";
  assert.equal(await editor.textContent(), committed);
  await microphone.click();
  await page.locator('.codex-composer-voice-footer[data-voice-phase="listening"]').waitFor();
  assert.equal(await editor.textContent(), committed);
  await cancel.click();
  assert.equal(await editor.textContent(), committed);
  await microphone.click();
  await page.locator('.codex-composer-voice-footer[data-voice-phase="listening"]').waitFor();
  assert.equal(await editor.textContent(), committed);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector(".ProseMirror")?.textContent?.includes("Native fixture transcript")
    && !document.querySelector(".ProseMirror")?.textContent?.includes("Late canceled native speech"));
  console.log("SYNTHETIC_DRAFT_ISOLATED");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.locator("#native-speech-device").selectOption("fixture-b");
  await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>("#native-speech-language")?.disabled);
  await page.locator("#native-speech-language").selectOption("zh-CN");
  await page.getByText("当前语言不支持端侧识别，可能使用 Apple 语音服务", { exact: true }).waitFor();
  const preferences = await page.evaluate(() => (window as any).opencraftDesktop.speech.readPreferences());
  assert.deepEqual(preferences, { deviceId: "fixture-b", language: "zh-CN" });
  await page.screenshot({ path: "/tmp/opencraft-native-speech-desktop.png" });
  await desktop.close(); desktop = undefined;
  page = await launch(true);
  assert.deepEqual(await page.evaluate(() => (window as any).opencraftDesktop.speech.readPreferences()), preferences);
  assert.deepEqual(errors, []);
  console.log("PASS: native no-capture probe; multi-utterance final-only insertion preserves original draft, cancel/draft/device persistence; no chat model or microphone recording");
} catch (error) {
  try { await (await desktop?.firstWindow())?.screenshot({ path: "/tmp/opencraft-native-speech-failure.png" }); } catch {}
  throw error;
} finally {
  await desktop?.close();
  await rm(directory, { recursive: true, force: true });
}
