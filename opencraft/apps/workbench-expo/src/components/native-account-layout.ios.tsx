import { useEffect, useSyncExternalStore } from "react";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LightVelaAccountGate } from "./lightvela-account-gate";
import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";

export function NativeAccountLayout() {
  const { ready } = useSyncExternalStore(
    mobileLanguagePreference.subscribe,
    mobileLanguagePreference.getSnapshot,
    mobileLanguagePreference.getSnapshot,
  );
  useEffect(() => { void mobileLanguagePreference.initialize(); }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <SafeAreaProvider>
          {ready ? (
            <LightVelaAccountGate account={mobileAccount} allowWithoutBot>
              <StatusBar style="dark" />
              <Slot />
            </LightVelaAccountGate>
          ) : <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator /></View>}
        </SafeAreaProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
