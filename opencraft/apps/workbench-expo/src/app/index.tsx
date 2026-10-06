import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Button, Card } from "heroui-native";
import { ArrowLeft } from "lucide-react-native";
import { ActivityIndicator, Keyboard, Linking, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { accountOperations } from "@opencraft/mobile-account-sdk";
import { nativeTokens } from "@opencraft/design-system/tokens.native";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { MobileAccountOverview } from "../components/mobile-account-overview.ios";
import { MobileBotHost } from "../components/mobile-bot-host.ios";
import { NativeNavigationSurface } from "../components/native-navigation-surface.ios";
import { mobileLanguageCopy, resolveMobileLanguage, siteLocaleForMobileLanguage } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { mobileShellTransition } from "../runtime/mobile-shell-model";
import {
  createLightVelaMobileShellBootstrap,
  createLightVelaLocaleBootstrap,
  createLightVelaLocaleChange,
  createLightVelaPageDiagnostics,
  createLightVelaSiteBootstrap,
  createLightVelaStaticPrefetch,
  lightVelaSiteTabForUrl,
  lightVelaSiteTabUrl,
  type LightVelaSiteTab,
} from "../runtime/lightvela-site-webview";

export default function HomeRoute() {
  const insets = useSafeAreaInsets();
  const { region } = useSyncExternalStore(mobileAccount.subscribe, mobileAccount.getSnapshot, mobileAccount.getSnapshot);
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  const language = resolveMobileLanguage(preference, region);
  const copy = mobileLanguageCopy(language);
  const siteLocale = siteLocaleForMobileLanguage(language, region);
  const webView = useRef<WebView>(null);
  const session = mobileAccount.getAuthenticatedSession();
  const appliedLocale = useRef({ region, siteLocale });
  const [surface, navigate] = useReducer(mobileShellTransition, "agents");
  const [accountOpened, setAccountOpened] = useState(false);
  const activeTab: LightVelaSiteTab = surface === "agents" ? "agents" : surface === "billing" ? "billing" : "account";
  const accountDetailsOpen = surface === "account-web";
  const token = session?.token ?? null;
  const accountScope = session?.credentialScope ?? null;
  const [error, setError] = useState<"sessionExpired" | "sessionOpenFailed" | "verifyFailed" | null>(null);
  useEffect(() => {
    const previous = appliedLocale.current;
    appliedLocale.current = { region, siteLocale };
    if (previous.region === region && previous.siteLocale !== siteLocale) {
      webView.current?.injectJavaScript(createLightVelaLocaleChange(region, siteLocale));
    }
  }, [region, siteLocale]);
  const signOutFromAccount = async () => {
    const sessionToken = await mobileAccount.webSessionToken();
    if (sessionToken) {
      const operation = accountOperations.signOut();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        await fetch(`${LIGHTVELA_REGIONS[region].apiBase}${operation.path}`, {
          method: operation.method,
          headers: { Authorization: `Bearer ${sessionToken}` },
          signal: controller.signal,
        });
      } catch { /* Local sign-out must still finish when the network is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    await mobileAccount.signOut();
  };
  if (error || !token || !accountScope) return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 justify-center bg-background p-6">
        <Card variant="secondary" className="w-full max-w-md self-center">
          <Card.Body className="gap-3">
            <Card.Title>{copy.openFailedTitle}</Card.Title>
            <Card.Description>{copy[error ?? "sessionOpenFailed"]}</Card.Description>
          </Card.Body>
          <Card.Footer><Button className="w-full" onPress={() => {
            setError(null);
            void mobileAccount.retry().catch(() => setError("verifyFailed"));
          }}>{copy.retry}</Button></Card.Footer>
        </Card>
      </View>
    </SafeAreaView>
  );

  const botActive = activeTab === "agents";
  const webOpen = accountDetailsOpen || surface === "billing";

  return (
    <View style={{ flex: 1, backgroundColor: nativeTokens.material.canvas }}>
      {/* Geometry changes keep these owners in the same React positions. */}
      <View pointerEvents={botActive ? "auto" : "none"} accessibilityElementsHidden={!botActive} style={{ flex: 1 }}>
            <MobileBotHost key={accountScope} region={region} language={language} token={token} credentialScope={accountScope} active={botActive} onOpenAccount={() => { setAccountOpened(true); Keyboard.dismiss(); navigate({ type: "open-account" }); }} onSignOut={() => { void mobileAccount.signOut().catch(() => undefined); }} onExternalNavigation={href => {
              try {
                const destination = new URL(href, siteOrigin);
                if (destination.origin === siteOrigin) {
                  const tab = lightVelaSiteTabForUrl(destination.href, region);
                  if (tab === "account" || tab === "billing") {
                    setAccountOpened(true);
                    Keyboard.dismiss();
                    navigate({ type: tab === "account" ? "open-account-web" : "open-billing" });
                    webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(destination.href)}); true;`);
                    return;
                  }
                }
                if (["https:", "mailto:", "tel:"].includes(destination.protocol)) void Linking.openURL(destination.href).catch(() => undefined);
              } catch { /* Ignore invalid navigation. */ }
            }} />
      </View>
      <NativeNavigationSurface adaptive entryKey={surface} visible={!botActive} onDismiss={() => navigate({ type: surface === "account" ? "close-overlay" : "back" })}>
        {(dismiss, presentation) => <View style={{ flex: 1, paddingTop: presentation === "page" ? insets.top : 0, paddingBottom: presentation === "page" ? insets.bottom : 0, paddingLeft: presentation === "page" ? insets.left : 0, paddingRight: presentation === "page" ? insets.right : 0 }}>
          <View pointerEvents={webOpen ? "auto" : "none"} accessibilityElementsHidden={!webOpen} style={{ flex: 1, opacity: webOpen ? 1 : 0 }}>
            <Button variant="ghost" onPress={dismiss} accessibilityLabel={copy.back} style={{ alignSelf: "flex-start", minHeight: 44 }}>
              <ArrowLeft size={20} color={nativeTokens.color.icon.primary} /> {copy.back}
            </Button>
          <WebView
          ref={webView}
          key={region}
          style={{ flex: 1 }}
          source={{ uri: lightVelaSiteTabUrl(region, "account") }}
          originWhitelist={[siteOrigin]}
          cacheEnabled
          incognito={false}
          allowsBackForwardNavigationGestures
          javaScriptEnabled
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={token
            ? `${createLightVelaLocaleBootstrap(region, siteLocale)}\n${createLightVelaSiteBootstrap(token, region)}\n${createLightVelaMobileShellBootstrap(region)}\n${createLightVelaPageDiagnostics(region)}`
            : undefined}
          injectedJavaScript={createLightVelaStaticPrefetch(region)}
          onLoadStart={() => mobileDeveloperLog.log("site.load.started")}
          onLoadEnd={() => mobileDeveloperLog.log("site.load.finished")}
          onError={() => mobileDeveloperLog.log("site.load.failed")}
          onHttpError={({ nativeEvent }) => {
            mobileDeveloperLog.log("site.http.failed", { status: nativeEvent.statusCode });
          }}
          onNavigationStateChange={({ url }) => {
            const destination = lightVelaSiteTabForUrl(url, region);
            if (destination && destination !== "agents") navigate({ type: "site-navigation", destination });
          }}
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
            let message: { type?: unknown; href?: unknown; lang?: unknown; visibleChars?: unknown };
            try { message = JSON.parse(nativeEvent.data) as typeof message; } catch { return; }
            if (message.type === "signed-out") void mobileAccount.signOut().catch(() => undefined);
            if (message.type === "session-unavailable") {
              mobileDeveloperLog.log("site.session.unavailable");
              setError("sessionOpenFailed");
            }
            if (message.type === "site-script-failed") mobileDeveloperLog.log("site.script.failed");
            if (message.type === "site-health" && typeof message.visibleChars === "number") {
              const visibleChars = Math.max(0, Math.floor(message.visibleChars));
              mobileDeveloperLog.log(visibleChars === 0 ? "site.dom.empty" : "site.dom.ready", { visibleChars });
            }
            if (message.type === "site-location" && typeof message.href === "string") {
              const destination = lightVelaSiteTabForUrl(message.href, region);
              if (destination && destination !== "agents") navigate({ type: "site-navigation", destination });
            }
          }}
          renderLoading={() => <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>}
          startInLoadingState
          />
          </View>
          <View pointerEvents={surface === "account" ? "auto" : "none"} accessibilityElementsHidden={surface !== "account"} style={{ position: "absolute", top: presentation === "page" ? insets.top : 0, right: presentation === "page" ? insets.right : 0, bottom: presentation === "page" ? insets.bottom : 0, left: presentation === "page" ? insets.left : 0, opacity: surface === "account" ? 1 : 0 }}>
            <Button variant="ghost" style={{ alignSelf: "flex-start", marginLeft: 14, minHeight: 44 }} onPress={dismiss} accessibilityLabel={copy.back}>
              <ArrowLeft size={22} color={nativeTokens.color.icon.primary} />
            </Button>
              {accountOpened ? <MobileAccountOverview key={accountScope} region={region} accountScope={accountScope} language={language} onOpenDetails={() => {
                navigate({ type: "open-account-web" });
                webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(lightVelaSiteTabUrl(region, "account"))}); true;`);
              }} onOpenRealname={() => {
                const destination = new URL(lightVelaSiteTabUrl(region, "account"));
                destination.searchParams.set("open", "realname");
                navigate({ type: "open-account-web" });
                webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(destination.href)}); true;`);
              }} onSignOut={signOutFromAccount} onProfileUpdated={event => {
                webView.current?.injectJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(event)})); true;`);
              }} onOpenBilling={() => {
                navigate({ type: "open-billing" });
                webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(lightVelaSiteTabUrl(region, "billing"))}); true;`);
              }} /> : null}
          </View>
        </View>}
      </NativeNavigationSurface>
    </View>
  );
}
