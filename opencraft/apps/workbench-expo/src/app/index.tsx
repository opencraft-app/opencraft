import { useEffect, useState } from "react";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { ActivityIndicator, Alert, Linking, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";

import { mobileAccount } from "../runtime/mobile-account-instance";
import {
  createLightVelaSiteBootstrap,
  EXPO_GO_AUTH_ORIGINS,
  isExpoGoAuthNavigation,
  isExpoGoGoogleAuthStart,
  LIGHTVELA_SITE_URL,
  LIGHTVELA_STATIC_PREFETCH,
} from "../runtime/lightvela-site-webview";

export default function HomeRoute() {
  const expoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expoGo) return;
    let active = true;
    void mobileAccount.webSessionToken().then(value => {
      if (!active) return;
      if (value) setToken(value);
      else setError("Your session has expired. Please sign in again.");
    }).catch(() => {
      if (active) setError("Could not open your LightVela session.");
    });
    return () => { active = false; };
  }, [expoGo]);

  if (error) return <SafeAreaView style={{ flex: 1, justifyContent: "center", padding: 24 }}><Text>{error}</Text></SafeAreaView>;
  if (!token && !expoGo) return <SafeAreaView style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></SafeAreaView>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }} edges={["top", "bottom"]}>
      <WebView
        source={{ uri: LIGHTVELA_SITE_URL }}
        originWhitelist={expoGo ? ["https://lightvela.ai", ...EXPO_GO_AUTH_ORIGINS] : ["https://lightvela.ai"]}
        cacheEnabled
        incognito={false}
        allowsBackForwardNavigationGestures
        javaScriptEnabled
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={token ? createLightVelaSiteBootstrap(token) : undefined}
        injectedJavaScript={LIGHTVELA_STATIC_PREFETCH}
        onShouldStartLoadWithRequest={({ url }) => {
          if (url === "about:blank") return true;
          try {
            const destination = new URL(url);
            if (destination.origin === "https://lightvela.ai") return true;
            if (expoGo && isExpoGoGoogleAuthStart(url)) {
              Alert.alert("Google sign-in", "Google sign-in needs the installed OpenCraft app. In Expo Go, use GitHub or guest access.");
              return false;
            }
            if (expoGo && isExpoGoAuthNavigation(url)) return true;
            if (["https:", "http:", "mailto:", "tel:"].includes(destination.protocol)) {
              void Linking.openURL(url).catch(() => undefined);
            }
          } catch { /* Reject invalid navigation. */ }
          return false;
        }}
        onMessage={({ nativeEvent }) => {
          let type: unknown;
          try { type = (JSON.parse(nativeEvent.data) as { type?: unknown }).type; } catch { return; }
          if (type === "signed-out" && !expoGo) void mobileAccount.signOut().catch(() => undefined);
          if (type === "session-unavailable") setError("Could not open your LightVela session.");
        }}
        renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>}
        startInLoadingState
      />
    </SafeAreaView>
  );
}
