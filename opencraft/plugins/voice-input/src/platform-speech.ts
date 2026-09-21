import type { NativeSpeechPort } from "@opencraft/app-host-protocol";
import { NativeSpeechInputProvider } from "./native-speech-provider";
import { BrowserSpeechInputProvider, type SpeechInputProvider } from "./speech-input-provider";

export function nativeSpeechPort(): NativeSpeechPort | null {
  const desktop = (globalThis as typeof globalThis & {
    opencraftDesktop?: { kind?: string; platform?: string; speech?: NativeSpeechPort };
  }).opencraftDesktop;
  return desktop?.kind === "electron" && desktop.platform === "darwin" && desktop.speech ? desktop.speech : null;
}
export function platformSpeechInputProvider(): SpeechInputProvider {
  const port = nativeSpeechPort(); if (port) return new NativeSpeechInputProvider(port);
  if ((globalThis as any).opencraftDesktop?.kind === "electron") return {
    id: "vela.desktop-speech-unavailable", unavailableMessage: "当前桌面平台尚未接通原生语音输入", isAvailable: () => false,
    start: () => { throw new Error("Native speech is unavailable"); },
  };
  return new BrowserSpeechInputProvider();
}
