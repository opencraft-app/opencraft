import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";

import {
  BrowserSpeechInputProvider,
  type SpeechInputProvider,
} from "./speech-input-provider";
import { createVoiceInputAction } from "./voice-input-action";

export function createVoiceInputExtension(
  provider: SpeechInputProvider = new BrowserSpeechInputProvider(),
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
      api.internal.register("composerActionRenderer", {
        id: "vela.voice-input.toggle",
        order: 100,
        Component: VoiceInputAction,
      });
    },
  };
}
