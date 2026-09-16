import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";

import type { SpeechInputProvider } from "./speech-input-provider";
import { nativeSpeechPort, platformSpeechInputProvider } from "./platform-speech";
import { createVoiceSettingsView } from "./voice-settings";
import { createVoiceInputAction } from "./voice-input-action";

export function createVoiceInputExtension(
  provider: SpeechInputProvider = platformSpeechInputProvider(),
): TrustedExtensionDefinition {
  const VoiceInputAction = createVoiceInputAction(provider);
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
