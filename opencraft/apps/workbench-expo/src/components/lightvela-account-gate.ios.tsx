import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, ActivityIndicator, Image, ScrollView, StyleSheet, View } from "react-native";
import { Button, Tabs, Typography } from "heroui-native";
import { Settings2 } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";
import { mobileLanguageCopy, resolveMobileLanguage } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { MobileSettingsModal } from "./mobile-settings-modal.ios";

const brandIcon = require("../../assets/lightvela-icon.png") as number;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8f7fb" },
  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 28, paddingVertical: 48 },
  panel: { width: "100%", maxWidth: 440, alignSelf: "center" },
  icon: { width: 76, height: 76, borderRadius: 20, marginBottom: 22 },
  eyebrow: { color: "#6c35c8", marginBottom: 10 },
  heading: { color: "#20162d", marginBottom: 10 },
  description: { color: "#675f72", marginBottom: 40 },
  sectionLabel: { color: "#675f72", marginBottom: 12 },
  tabs: { width: "100%", marginBottom: 28 },
  tabList: { width: "100%" },
  tab: { flex: 1 },
  action: { width: "100%", backgroundColor: "#672ad4" },
  error: { color: "#c4374a", marginTop: 16 },
  footer: { color: "#8b8396", marginTop: 28, textAlign: "center" },
  settingsAction: { alignSelf: "flex-end", marginRight: 22, marginTop: 8, width: 48, height: 48, borderRadius: 16 },
});

export function LightVelaAccountGate({ account, children, allowWithoutBot = false }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode; readonly allowWithoutBot?: boolean }) {
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
  const busy = snapshot.phase === "loading";
  return (
    <SafeAreaView style={styles.screen}>
      <Button variant="ghost" size="sm" style={styles.settingsAction} accessibilityLabel={copy.settings} onPress={() => setSettingsOpen(true)}>
        <Settings2 size={23} color="#554966" />
      </Button>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.panel}>
        <Image source={brandIcon} style={styles.icon} accessibilityLabel="LightVela" />
        <Typography type="body-xs" style={styles.eyebrow}>LIGHTVELA  /  OPENCRAFT</Typography>
        <Typography.Heading type="h2" style={styles.heading}>{copy.welcome}</Typography.Heading>
        <Typography type="body" style={styles.description}>
          {copy.welcomeDescription}
        </Typography>

        <Typography type="body-sm" style={styles.sectionLabel}>{copy.chooseRegion}</Typography>
        <Tabs value={snapshot.region} onValueChange={value => {
          if (value === "cn" || value === "intl") void account.selectRegion(value).catch(() => undefined);
        }} style={styles.tabs}>
          <Tabs.List style={styles.tabList}>
            <Tabs.Indicator />
            <Tabs.Trigger value="cn" isDisabled={busy || snapshot.phase === "error"} style={styles.tab}><Tabs.Label>{copy.chinaRegion}</Tabs.Label></Tabs.Trigger>
            <Tabs.Trigger value="intl" isDisabled={busy || snapshot.phase === "error"} style={styles.tab}><Tabs.Label>{copy.internationalRegion}</Tabs.Label></Tabs.Trigger>
          </Tabs.List>
        </Tabs>

        <Button size="lg" style={styles.action} isDisabled={busy} onPress={() => {
          void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined);
        }}>
          {busy ? <ActivityIndicator color="white" /> : copy.signIn}
        </Button>
        {snapshot.error ? <Typography type="body-sm" style={styles.error}>{copy.signInError}</Typography> : null}
        <Typography type="body-xs" style={styles.footer}>OpenCraft × LightVela</Typography>
      </View>
      </ScrollView>
      <MobileSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} region={snapshot.region} />
    </SafeAreaView>
  );
}
