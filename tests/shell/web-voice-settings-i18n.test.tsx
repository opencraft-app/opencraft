import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { WorkbenchIntlProvider, WorkbenchLocaleController } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { createWebVoiceSettings } from "../../plugins/voice-input/src/web-voice-settings";
import type { SpeechServiceClient, VoiceInputPreference } from "../../plugins/voice-input/src/cloud-speech";

const snapshot = {
  phase: "unavailable" as const,
  binding: null,
  revision: 1,
  selection: null,
  models: [{ providerId: "provider", modelId: "model", name: "Hunyuan", enabled: false }],
};
const service = {
  getSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  refresh: async () => undefined,
  selectModel: async () => undefined,
} as unknown as SpeechServiceClient;

function usePreferences(): VoiceInputPreference {
  return { provider: "auto", setProvider: async () => undefined };
}

test("web voice settings follows the active locale", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousReact = (globalThis as { React?: typeof React }).React;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
  });
  const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
  await locale.initialize();
  const VoiceSettings = createWebVoiceSettings(service, usePreferences);
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => {
      root.render(
        <UiPreferencesProvider runtime={preferences}>
          <WorkbenchIntlProvider controller={locale} target={dom.window.document.documentElement}>
            <VoiceSettings />
          </WorkbenchIntlProvider>
        </UiPreferencesProvider>,
      );
    });
    const text = () => dom.window.document.body.textContent ?? "";
    assert.match(text(), /Voice input/);
    assert.match(text(), /Transcription model/);
    assert.match(text(), /Not selected/);
    assert.doesNotMatch(text(), /语音输入/);

    await React.act(async () => { await locale.configure({ ideLocale: "zh-CN" }); });
    assert.match(text(), /语音输入/);
    assert.match(text(), /转写模型/);
    assert.match(text(), /未选择/);
    assert.match(text(), /停止录音可写入文字，也可选择识别后发送。/);
    assert.doesNotMatch(text(), /Transcription model/);
  } finally {
    await React.act(async () => root.unmount());
    locale.dispose();
    await preferences.close();
    dom.window.close();
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      IS_REACT_ACT_ENVIRONMENT: previousActEnvironment,
      React: previousReact,
    });
  }
});
