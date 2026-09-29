import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Card } from "heroui-native";
import { ActivityIndicator, Linking, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { LightVelaSiteTabs } from "../components/lightvela-site-tabs.ios";
import { MobileSettingsScreen } from "../components/mobile-settings-modal.ios";
import { mobileLanguageCopy, resolveMobileLanguage, siteLocaleForMobileLanguage } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import {
  createLightVelaMobileShellBootstrap,
  createLightVelaLocaleBootstrap,
  createLightVelaLocaleChange,
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
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  const language = resolveMobileLanguage(preference, region);
  const copy = mobileLanguageCopy(language);
  const siteLocale = siteLocaleForMobileLanguage(language, region);
  const webView = useRef<WebView>(null);
  const appliedLocale = useRef({ region, siteLocale });
  const [activeTab, setActiveTab] = useState<LightVelaSiteTab | null>("agents");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<"sessionExpired" | "sessionOpenFailed" | "verifyFailed" | null>(null);

  useEffect(() => {
    let active = true;
    void mobileAccount.webSessionToken().then(value => {
      if (!active) return;
      if (value) setToken(value);
      else setError("sessionExpired");
    }).catch(() => {
      if (active) setError("sessionOpenFailed");
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const previous = appliedLocale.current;
    appliedLocale.current = { region, siteLocale };
    if (previous.region === region && previous.siteLocale !== siteLocale) {
      webView.current?.injectJavaScript(createLightVelaLocaleChange(region, siteLocale));
    }
  }, [region, siteLocale]);
  if (error || !token) return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 justify-center bg-background p-6">
        <Card variant="secondary" className="w-full max-w-md self-center">
          <Card.Body className="gap-3">
            <Card.Title>{error ? copy.openFailedTitle : copy.opening}</Card.Title>
            <Card.Description>{error ? copy[error] : copy.preparing}</Card.Description>
            {!error ? <ActivityIndicator /> : null}
          </Card.Body>
          {error ? <Card.Footer><Button className="w-full" onPress={() => {
            setError(null);
            void mobileAccount.retry().catch(() => setError("verifyFailed"));
          }}>{copy.retry}</Button></Card.Footer> : null}
        </Card>
      </View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }} edges={["top", "bottom"]}>
      <View style={{ flex: 1 }}>
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
            ? `${createLightVelaLocaleBootstrap(region, siteLocale)}\n${createLightVelaSiteBootstrap(token, region)}\n${createLightVelaMobileShellBootstrap(region)}`
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
            if (message.type === "session-unavailable") setError("sessionOpenFailed");
            if (message.type === "site-location" && typeof message.href === "string") {
              setActiveTab(lightVelaSiteTabForUrl(message.href, region));
            }
          }}
          renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>}
          startInLoadingState
        />
        {settingsOpen ? (
          <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
            <MobileSettingsScreen region={region} />
          </View>
        ) : null}
      </View>
      <LightVelaSiteTabs language={language} activeTab={settingsOpen ? "settings" : activeTab} onSettings={() => setSettingsOpen(true)} onSelect={tab => {
        setSettingsOpen(false);
        setActiveTab(tab);
        const destination = lightVelaSiteTabUrl(region, tab);
        webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(destination)}); true;`);
      }} />
    </SafeAreaView>
  );
}
