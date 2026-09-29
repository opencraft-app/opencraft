import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import "../../global.css";
import { LightVelaAccountGate } from "./lightvela-account-gate";
import { mobileAccount } from "../runtime/mobile-account-instance";

export function NativeAccountLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <SafeAreaProvider>
          <LightVelaAccountGate account={mobileAccount} allowWithoutBot>
            <StatusBar style="dark" />
            <Slot />
          </LightVelaAccountGate>
        </SafeAreaProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
