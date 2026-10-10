import { useReducer, useState, useSyncExternalStore } from "react";
import { Button, Card } from "heroui-native";
import { ArrowLeft } from "lucide-react-native";
import { Keyboard, Linking, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LIGHTVELA_REGIONS } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { accountOperations } from "@opencraft/mobile-account-sdk";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { mobileAccount } from "../runtime/mobile-account-instance";
import { MobileAccountOverview } from "./mobile-account-overview.ios";
import { MobileBotHost } from "./mobile-bot-host.ios";
import { NativeNavigationSurface } from "./native-navigation-surface.ios";
import { mobileLanguageCopy, resolveMobileLanguage } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { mobileShellTransition } from "../runtime/mobile-shell-model";
import { lightVelaSiteTabUrl } from "../runtime/lightvela-site-webview";

export default function HomeRoute() {
  const insets = useSafeAreaInsets();
  const { region } = useSyncExternalStore(mobileAccount.subscribe, mobileAccount.getSnapshot, mobileAccount.getSnapshot);
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  const language = resolveMobileLanguage(preference, region), copy = mobileLanguageCopy(language);
  const session = mobileAccount.getAuthenticatedSession();
  const token = session?.token ?? null, accountScope = session?.credentialScope ?? null;
  const [surface, navigate] = useReducer(mobileShellTransition, "agents");
  const [accountOpened, setAccountOpened] = useState(false);
  const [error, setError] = useState<"sessionExpired" | "sessionOpenFailed" | "verifyFailed" | null>(null);
  const openExternal = (href: string) => {
    try {
      const destination = new URL(href, siteOrigin);
      if (["https:", "mailto:", "tel:"].includes(destination.protocol)) {
        void Linking.openURL(destination.href).catch(() => mobileDeveloperLog.log("site.external.open.failed"));
      }
    } catch { mobileDeveloperLog.log("site.external.open.failed"); }
  };
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


  const botActive = surface === "agents";
  return <View style={{ flex: 1, backgroundColor: nativeTokens.material.canvas }}>
    <View pointerEvents={botActive ? "auto" : "none"} accessibilityElementsHidden={!botActive} style={{ flex: 1 }}>
      <MobileBotHost key={accountScope} region={region} language={language} token={token} credentialScope={accountScope} active={botActive}
        onOpenAccount={() => { setAccountOpened(true); Keyboard.dismiss(); navigate({ type: "open-account" }); }}
        onSignOut={() => { void mobileAccount.signOut().catch(() => undefined); }} onExternalNavigation={openExternal} />
    </View>
    <NativeNavigationSurface adaptive entryKey={surface} visible={!botActive} onDismiss={() => navigate({ type: "close-overlay" })}>
      {(dismiss, presentation) => <View style={{ flex: 1, paddingTop: presentation === "page" ? insets.top : 0, paddingBottom: presentation === "page" ? insets.bottom : 0, paddingLeft: presentation === "page" ? insets.left : 0, paddingRight: presentation === "page" ? insets.right : 0 }}>
        <Button variant="ghost" style={{ alignSelf: "flex-start", marginLeft: 14, minHeight: 44 }} onPress={dismiss} accessibilityLabel={copy.back}>
          <ArrowLeft size={22} color={nativeTokens.color.icon.primary} />
        </Button>
        {accountOpened ? <MobileAccountOverview key={accountScope} region={region} accountScope={accountScope} language={language}
          onOpenDetails={() => openExternal(lightVelaSiteTabUrl(region, "account"))}
          onOpenRealname={() => { const destination = new URL(lightVelaSiteTabUrl(region, "account")); destination.searchParams.set("open", "realname"); openExternal(destination.href); }}
          onOpenBilling={() => openExternal(lightVelaSiteTabUrl(region, "billing"))}
          onSignOut={signOutFromAccount} /> : null}
      </View>}
    </NativeNavigationSurface>
  </View>;
}
