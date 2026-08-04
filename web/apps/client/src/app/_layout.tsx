import { Stack } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationLinkProvider,
  useAppActive,
  useVelaFonts,
} from "@/ui";
import {ExpoNavigationLink} from "../features/navigation/expo-navigation-link";
import { AppRuntimeProvider, useAppRuntime } from "../runtime/app-runtime";
import { createDefaultStore } from "../runtime/default-runtime";

export default function RootLayout() {
  const [store] = useState(createDefaultStore);
  const [fontsLoaded, fontError] = useVelaFonts();

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <AppRuntimeProvider store={store}>
        <NavigationLinkProvider component={ExpoNavigationLink}>
          <Bootstrap>
            <Stack screenOptions={{ headerShown: false }} />
          </Bootstrap>
        </NavigationLinkProvider>
      </AppRuntimeProvider>
    </SafeAreaProvider>
  );
}

function Bootstrap({ children }: { children: ReactNode }) {
  const { store } = useAppRuntime();

  useEffect(() => {
    void store.getState().initialize();
  }, [store]);

  useAppActive(() => {
    void store.getState().refreshDirectConversations();
  });

  return children;
}
