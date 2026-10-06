import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, ActivityIndicator, Image, ScrollView, StyleSheet, View } from "react-native";
import { Image as CachedImage } from "expo-image";
import * as Network from "expo-network";
import { Button, Typography } from "heroui-native";
import { ArrowUpRight, Settings2 } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";
import { mobileLanguageCopy, resolveMobileLanguage } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { MobileSettingsModal } from "./mobile-settings-modal.ios";
import { mobileAccountDisplayCache } from "../runtime/mobile-account-display-cache.native";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { lightVelaLoginMark } from "../assets/lightvela-login-mark";
import type { AccountDisplaySnapshot } from "@opencraft/mobile-account-sdk/display-cache";

const brandIcon = { uri: lightVelaLoginMark };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mobileVisualTokens.color.surface },
  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 28, paddingVertical: 48 },
  panel: { width: "100%", maxWidth: 440, alignSelf: "center" },
  icon: { width: 76, height: 76, borderRadius: 20, marginBottom: 22 },
  eyebrow: { color: "#6c35c8", marginBottom: 10 },
  heading: { color: "#20162d", marginBottom: 10 },
  description: { color: "#675f72", marginBottom: 40 },
  action: { width: "100%", backgroundColor: "#672ad4" },
  error: { color: "#c4374a", marginTop: 16 },
  footer: { color: "#8b8396", marginTop: 28, textAlign: "center" },
  settingsAction: { alignSelf: "flex-end", marginRight: 22, marginTop: 8, width: 48, height: 48, borderRadius: 16 },
  offlineAvatar: { width: 64, height: 64, borderRadius: 20, marginBottom: 18 },
  loginContent: { flexGrow: 1, width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 26 },
  loginHeader: { minHeight: 66, alignItems: "flex-end", justifyContent: "center" },
  loginSettings: { width: 46, height: 46, minWidth: 46, borderRadius: 23, backgroundColor: mobileVisualTokens.color.accentSoft },
  loginHero: { flexGrow: 1, minHeight: 340, alignItems: "center", justifyContent: "center", paddingVertical: 36, overflow: "hidden" },
  loginOrbit: { position: "absolute", width: 210, height: 210, borderRadius: 105, backgroundColor: mobileVisualTokens.color.accentSoft, opacity: 0.7 },
  orbitTop: { top: 12, right: -96 },
  orbitBottom: { bottom: 10, left: -142, width: 240, height: 240, borderRadius: 120 },
  loginMarkFrame: { width: 130, height: 130, borderRadius: 42, backgroundColor: mobileVisualTokens.color.accentSoft, alignItems: "center", justifyContent: "center", marginBottom: 35 },
  loginMark: { width: 106, height: 106, borderRadius: 34 },
  loginEyebrow: { color: mobileVisualTokens.color.accent, letterSpacing: 1.4, marginBottom: 12 },
  loginTitle: { color: mobileVisualTokens.color.text, fontSize: 46, lineHeight: 54, textAlign: "center" },
  loginDescription: { color: mobileVisualTokens.color.icon, textAlign: "center", maxWidth: 300, marginTop: 14, lineHeight: 25 },
  loginBottom: { paddingTop: 20, paddingBottom: 24 },
  loginActionRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  loginCancel: { minHeight: 56, borderRadius: 28, paddingHorizontal: 18, backgroundColor: mobileVisualTokens.color.accentSoft },
  loginAction: { flex: 1, minHeight: 56, borderRadius: 28, backgroundColor: mobileVisualTokens.color.text },
  loginActionLabel: { color: mobileVisualTokens.color.surface, fontWeight: "700" },
  loginFooter: { color: mobileVisualTokens.color.label, marginTop: 20, textAlign: "center" },
});

function OfflineIdentity({ account, region, language }: {
  readonly account: MobileLightVelaAccount;
  readonly region: "cn" | "intl";
  readonly language: "zh-CN" | "en-US";
}) {
  const [display, setDisplay] = useState<AccountDisplaySnapshot | null>(null);
  useEffect(() => {
    let active = true;
    void account.webSessionToken().then(token => token ? mobileAccountDisplayCache.read(region, token) : null)
      .then(value => { if (active) setDisplay(value); });
    const network = Network.addNetworkStateListener(state => {
      if ((state.isInternetReachable ?? state.isConnected) === true) void account.retry().catch(() => undefined);
    });
    return () => { active = false; network.remove(); };
  }, [account, region]);
  const zh = language === "zh-CN";
  return <SafeAreaView style={styles.screen}><View style={styles.content}>
    <View style={styles.panel}>
      {display?.avatarUrl ? <CachedImage source={{ uri: display.avatarUrl }} cachePolicy="memory-disk" style={styles.offlineAvatar} />
        : <Image source={brandIcon} style={styles.icon} />}
      <Typography.Heading type="h2" style={styles.heading}>{display?.displayName ?? "LightVela"}</Typography.Heading>
      <Typography type="body" style={styles.description}>{zh ? "暂时无法连接，账号资料将在恢复连接后更新。" : "Connection unavailable. Your profile will refresh when connected."}</Typography>
      <Button size="lg" style={styles.action} onPress={() => { void account.retry().catch(() => undefined); }}>
        {zh ? "重新连接" : "Reconnect"}
      </Button>
      <Button variant="ghost" style={{ marginTop: 16 }} onPress={() => { void account.signOut().catch(() => undefined); }}>
        {zh ? "退出登录" : "Sign out"}
      </Button>
    </View>
  </View></SafeAreaView>;
}

export function LightVelaAccountGate({ account, children, allowWithoutBot = false, languageReady = true }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode; readonly allowWithoutBot?: boolean; readonly languageReady?: boolean }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  const language = resolveMobileLanguage(preference, snapshot.region);
  const copy = mobileLanguageCopy(language);
  useEffect(() => { void account.initialize().catch(() => undefined); }, [account]);
  useEffect(() => {
    if (snapshot.phase !== "authenticated" || allowWithoutBot) return;
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void account.retry().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [account, allowWithoutBot, snapshot.phase]);
  if (snapshot.phase === "authenticated") return children;
  if (snapshot.phase === "error" && snapshot.error === "session-offline") {
    return <OfflineIdentity account={account} region={snapshot.region} language={language} />;
  }
  const busy = snapshot.phase === "loading" || !languageReady;
  const waitingForBrowser = busy && snapshot.loginPending;
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.loginContent}>
      <View style={styles.loginHeader}>
        <Button variant="ghost" style={styles.loginSettings} accessibilityLabel={copy.settings} onPress={() => setSettingsOpen(true)}>
          <Settings2 size={21} color={mobileVisualTokens.color.accent} />
        </Button>
      </View>
      <View style={styles.loginHero}>
        <View pointerEvents="none" style={[styles.loginOrbit, styles.orbitTop]} />
        <View pointerEvents="none" style={[styles.loginOrbit, styles.orbitBottom]} />
        <View style={styles.loginMarkFrame}>
          <Image source={brandIcon} style={styles.loginMark} accessibilityLabel="LightVela" />
        </View>
        <Typography type="body-xs" style={styles.loginEyebrow}>LIGHTVELA  /  OPENCRAFT</Typography>
        <Typography.Heading type="h2" style={styles.loginTitle}>OpenCraft</Typography.Heading>
        <Typography type="body" style={styles.loginDescription}>{copy.welcomeDescription}</Typography>
      </View>
      <View style={styles.loginBottom}>
        <View style={styles.loginActionRow}>
          {waitingForBrowser ? <Button variant="secondary" style={styles.loginCancel} onPress={() => { void account.cancelSignIn().catch(() => undefined); }}>
            <Button.Label>{language === "zh-CN" ? "取消" : "Cancel"}</Button.Label>
          </Button> : null}
          <Button style={styles.loginAction} isDisabled={busy} accessibilityLabel={waitingForBrowser ? language === "zh-CN" ? "正在等待浏览器登录" : "Waiting for browser sign-in" : copy.signIn} onPress={() => {
            void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined);
          }}>
            {busy ? <ActivityIndicator color={mobileVisualTokens.color.surface} /> : <ArrowUpRight size={20} color={mobileVisualTokens.color.surface} />}
            <Button.Label style={styles.loginActionLabel}>{waitingForBrowser
              ? language === "zh-CN" ? "正在等待浏览器…" : "Waiting for browser…"
              : busy ? snapshot.loginPending ? copy.signingIn : copy.preparing : copy.signIn}</Button.Label>
          </Button>
        </View>
        {snapshot.error ? <Typography type="body-sm" style={styles.error}>{copy.signInError}</Typography> : null}
        <Typography type="body-xs" style={styles.loginFooter}>OpenCraft × LightVela</Typography>
      </View>
      </ScrollView>
      <MobileSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} region={snapshot.region}
        onRegionChange={region => account.selectRegion(region)} />
    </SafeAreaView>
  );
}
