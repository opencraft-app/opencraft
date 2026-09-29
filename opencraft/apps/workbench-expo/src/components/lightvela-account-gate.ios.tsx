import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AppState, ActivityIndicator, Image, ScrollView, StyleSheet, View } from "react-native";
import { Button, Tabs, Typography } from "heroui-native";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";

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
});

export function LightVelaAccountGate({ account, children, allowWithoutBot = false }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode; readonly allowWithoutBot?: boolean }) {
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
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
  const domestic = snapshot.region === "cn";
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.panel}>
        <Image source={brandIcon} style={styles.icon} accessibilityLabel="LightVela" />
        <Typography type="body-xs" style={styles.eyebrow}>LIGHTVELA  /  OPENCRAFT</Typography>
        <Typography.Heading type="h2" style={styles.heading}>{domestic ? "让创作继续" : "Keep ideas moving"}</Typography.Heading>
        <Typography type="body" style={styles.description}>
          {domestic ? "你的智能工作台，随时随地。" : "Your workspace, wherever inspiration finds you."}
        </Typography>

        <Typography type="body-sm" style={styles.sectionLabel}>{domestic ? "选择站点" : "Choose your region"}</Typography>
        <Tabs value={snapshot.region} onValueChange={value => {
          if (value === "cn" || value === "intl") void account.selectRegion(value).catch(() => undefined);
        }} style={styles.tabs}>
          <Tabs.List style={styles.tabList}>
            <Tabs.Indicator />
            <Tabs.Trigger value="cn" isDisabled={busy || snapshot.phase === "error"} style={styles.tab}><Tabs.Label>中国大陆</Tabs.Label></Tabs.Trigger>
            <Tabs.Trigger value="intl" isDisabled={busy || snapshot.phase === "error"} style={styles.tab}><Tabs.Label>International</Tabs.Label></Tabs.Trigger>
          </Tabs.List>
        </Tabs>

        <Button size="lg" style={styles.action} isDisabled={busy} onPress={() => {
          void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined);
        }}>
          {busy ? <ActivityIndicator color="white" /> : domestic ? "使用 LightVela 登录" : "Continue with LightVela"}
        </Button>
        {snapshot.error ? <Typography type="body-sm" style={styles.error}>{snapshot.error}</Typography> : null}
        <Typography type="body-xs" style={styles.footer}>OpenCraft × LightVela</Typography>
      </View>
    </ScrollView>
  );
}
