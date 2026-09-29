import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Card } from "heroui-native";
import { ActivityIndicator, Linking, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { LightVelaSiteTabs } from "../components/lightvela-site-tabs.ios";
import {
  createLightVelaMobileShellBootstrap,
  createLightVelaSiteBootstrap,
  createLightVelaStaticPrefetch,
  lightVelaSiteTabForUrl,
  lightVelaSiteTabUrl,
  lightVelaSiteUrl,
  type LightVelaSiteTab,
} from "../runtime/lightvela-site-webview";

export default function HomeRoute() {
  const { region } = useSyncExternalStore(mobileAccount.subscribe, mobileAccount.getSnapshot, mobileAccount.getSnapshot);
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  const webView = useRef<WebView>(null);
  const [activeTab, setActiveTab] = useState<LightVelaSiteTab | null>("agents");
  const [siteLanguage, setSiteLanguage] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void mobileAccount.webSessionToken().then(value => {
      if (!active) return;
      if (value) setToken(value);
      else setError("Your session has expired. Please sign in again.");
    }).catch(() => {
      if (active) setError("Could not open your LightVela session.");
    });
    return () => { active = false; };
  }, []);
  if (error || !token) return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 justify-center bg-background p-6">
        <Card variant="secondary" className="w-full max-w-md self-center">
          <Card.Body className="gap-3">
            <Card.Title>{error ? "Could not open LightVela" : "Opening LightVela"}</Card.Title>
            <Card.Description>{error ?? "Preparing your agents and conversations."}</Card.Description>
            {!error ? <ActivityIndicator /> : null}
          </Card.Body>
          {error ? <Card.Footer><Button className="w-full" onPress={() => {
            setError(null);
            void mobileAccount.retry().catch(() => setError("Could not verify your LightVela session."));
          }}>Try again</Button></Card.Footer> : null}
        </Card>
      </View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }} edges={["top", "bottom"]}>
      <WebView
        ref={webView}
        key={region}
        style={{ flex: 1 }}
        source={{ uri: lightVelaSiteUrl(region) }}
        originWhitelist={[siteOrigin]}
        cacheEnabled
        incognito={false}
        allowsBackForwardNavigationGestures
        javaScriptEnabled
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={token
          ? `${createLightVelaSiteBootstrap(token, region)}\n${createLightVelaMobileShellBootstrap(region)}`
          : undefined}
        injectedJavaScript={createLightVelaStaticPrefetch(region)}
        onNavigationStateChange={({ url }) => setActiveTab(lightVelaSiteTabForUrl(url, region))}
        onShouldStartLoadWithRequest={({ url }) => {
          if (url === "about:blank") return true;
          try {
            const destination = new URL(url);
            if (destination.origin === siteOrigin) return true;
            if (["https:", "http:", "mailto:", "tel:"].includes(destination.protocol)) {
              void Linking.openURL(url).catch(() => undefined);
            }
          } catch { /* Reject invalid navigation. */ }
          return false;
        }}
        onMessage={({ nativeEvent }) => {
          let message: { type?: unknown; href?: unknown; lang?: unknown };
          try { message = JSON.parse(nativeEvent.data) as typeof message; } catch { return; }
          if (message.type === "signed-out") void mobileAccount.signOut().catch(() => undefined);
          if (message.type === "session-unavailable") setError("Could not open your LightVela session.");
          if (message.type === "site-location" && typeof message.href === "string") {
            setActiveTab(lightVelaSiteTabForUrl(message.href, region));
            if (typeof message.lang === "string" && message.lang) setSiteLanguage(message.lang);
          }
        }}
        renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>}
        startInLoadingState
      />
      <LightVelaSiteTabs region={region} language={siteLanguage} activeTab={activeTab} onSelect={tab => {
        setActiveTab(tab);
        const destination = lightVelaSiteTabUrl(region, tab);
        webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(destination)}); true;`);
      }} />
    </SafeAreaView>
  );
}
