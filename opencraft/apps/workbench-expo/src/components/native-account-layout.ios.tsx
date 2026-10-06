import { useEffect, useSyncExternalStore } from "react";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LightVelaAccountGate } from "./lightvela-account-gate.ios";
import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { mobileAccountQueryClient, startMobileAccountQueryLifecycle } from "../runtime/mobile-account-query.native";
import { loadMobileBotRuntimeHtml } from "../runtime/mobile-bot-runtime-asset.ios";

export function NativeAccountLayout() {
  const { ready: languageReady } = useSyncExternalStore(
    mobileLanguagePreference.subscribe,
    mobileLanguagePreference.getSnapshot,
    mobileLanguagePreference.getSnapshot,
  );
  useEffect(() => { void mobileLanguagePreference.initialize(); }, []);
  useEffect(() => { startMobileAccountQueryLifecycle(); }, []);
  useEffect(() => { if (Platform.OS === "ios") void loadMobileBotRuntimeHtml().catch(() => undefined); }, []);
  const content = (
    <LightVelaAccountGate account={mobileAccount} allowWithoutBot languageReady={languageReady}>
      <StatusBar style="dark" />
      <Slot />
    </LightVelaAccountGate>
  );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={mobileAccountQueryClient}><HeroUINativeProvider>
        <SafeAreaProvider>
          {Platform.OS === "ios" ? <KeyboardProvider>{content}</KeyboardProvider> : content}
        </SafeAreaProvider>
      </HeroUINativeProvider></QueryClientProvider>
    </GestureHandlerRootView>
  );
}
