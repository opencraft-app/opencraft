import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";

import type { SpeechInputProvider } from "./speech-input-provider";
import { nativeSpeechPort, platformSpeechInputProvider } from "./platform-speech";
import { createVoiceSettingsView } from "./voice-settings";
import { createVoiceInputAction } from "./voice-input-action";
import { createElement, useMemo, useRef, useSyncExternalStore } from "react";
import type { ComposerActionHost } from "@opencraft/extension-react";
import { CloudSpeechInputProvider, SpeechServiceClient, type VoiceInputPreference } from "./cloud-speech";
import { createWebVoiceSettings } from "./web-voice-settings";

export function createVoiceInputExtension(
  provider: SpeechInputProvider = platformSpeechInputProvider(),
  options: { readonly webSpeech?: { usePreferences(): VoiceInputPreference } } = {},
): TrustedExtensionDefinition {
  const service = options.webSpeech ? new SpeechServiceClient() : null;
  const cloud = service ? new CloudSpeechInputProvider(service) : null;
  const PlatformVoiceInputAction = createVoiceInputAction(provider);
  const VoiceInputAction = options.webSpeech && service && cloud ? function WebVoiceInputAction(props: ComposerActionHost) {
    const preferences = options.webSpeech!.usePreferences();
    useSyncExternalStore(service.subscribe, service.getSnapshot);
    const choice = useRef(preferences.provider); choice.current = preferences.provider;
    // Stable delegate chooses once at start. Discovery never replaces a live capture/View.
    const Action = useMemo(() => createVoiceInputAction({
      id: "opencraft.web-speech", unavailableMessage: "语音服务暂不可用，请检查语音设置",
      isAvailable: () => choice.current === "hunyuan" ? cloud.isAvailable() : choice.current === "system" ? provider.isAvailable() : cloud.isAvailable() || provider.isAvailable(),
      start: (observer, settings) => (choice.current === "hunyuan" || (choice.current === "auto" && cloud.isAvailable()) ? cloud : provider).start(observer, settings),
    }), []);
    return createElement(Action, props);
  } : PlatformVoiceInputAction;
  return {
    manifest: {
      manifestVersion: 1,
      id: "vela.voice-input",
      name: "OpenCraft Voice Input",
      description: "Adds platform voice dictation to the Composer.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      if (service && cloud && options.webSpeech) {
        void service.refresh();
        api.subscriptions.add(() => { cloud.close(); service.close(); });
        api.views.register({ id: "vela.voice-input.web-settings-view", title: "语音输入", viewType: "vela.voice-input.web-settings", platforms: ["web"] });
        api.settings.registerPage({ id: "vela.voice-input.web-settings", title: "语音输入", viewId: "vela.voice-input.web-settings-view", group: "通用", icon: "sliders", platforms: ["web"], order: 40 });
        api.internal.register("platformViewRenderer", { viewType: "vela.voice-input.web-settings", Component: createWebVoiceSettings(service, options.webSpeech.usePreferences) });
      }
      const native = nativeSpeechPort();
      if (native) {
        api.views.register({ id: "vela.voice-input.settings-view", title: "语音输入", viewType: "vela.voice-input.settings", platforms: ["electron"] });
        api.settings.registerPage({ id: "vela.voice-input.settings", title: "语音输入", viewId: "vela.voice-input.settings-view", group: "通用", icon: "sliders", platforms: ["electron"], order: 40 });
        api.internal.register("platformViewRenderer", { viewType: "vela.voice-input.settings", Component: createVoiceSettingsView(native) });
      }
      api.internal.register("composerActionRenderer", {
        id: "vela.voice-input.toggle",
        order: 100,
        Component: VoiceInputAction,
      });
    },
  };
}
