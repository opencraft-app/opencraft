import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { IntlRuntimeProvider, useIntl } from "@opencraft/i18n/react";
import { BUNDLED_SOURCE, decodeContentSource, encodeContentSource, type MobileContentSource } from "../runtime/content-source";
import { mobileLocale, mobileMessages as m } from "../runtime/mobile-messages";
import { sourceStorage } from "../runtime/source-storage";
import { SourceSettings } from "./source-settings";
import { MobileMaterial } from "./mobile-material";
import { WorkspaceSurface } from "./workspace-surface";

function Shell() {
  const intl = useIntl();
  const systemDark = useColorScheme() === "dark";
  const [appearance, setAppearance] = useState<{ resolvedTheme: "light" | "dark"; edgeBackgroundColor: string } | null>(null);
  const [source, setSource] = useState<MobileContentSource | null>(null);
  const dark = source?.kind === "bundled" && appearance ? appearance.resolvedTheme === "dark" : systemDark;
  const theme = nativeThemes[dark ? "dark" : "light"];
  const [settings, setSettings] = useState(false);
  const [readError, setReadError] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const readGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    const generation = ++readGeneration.current;
    setReadError(false);
    void sourceStorage.read().then(decodeContentSource).then(value => { if (current && generation === readGeneration.current) setSource(value); })
      .catch(() => { if (current && generation === readGeneration.current) setReadError(true); });
    return () => { current = false; };
  }, [readAttempt]);
  const save = async (next: MobileContentSource) => {
    await sourceStorage.write(encodeContentSource(next));
    ++readGeneration.current;
    setSource(next); setAppearance(null); setReadError(false); setSettings(false);
  };
  const identity = source?.kind === "self-hosted" ? source.url : "bundled";
  return <SafeAreaView style={[styles.root, { backgroundColor: source?.kind === "bundled" && appearance ? appearance.edgeBackgroundColor : theme.material.content }]}>
    <StatusBar style={dark ? "light" : "dark"} />
    <MobileMaterial backgroundColor={theme.material.raised} style={styles.toolbar}>
      <Text numberOfLines={1} style={[styles.title, theme.platformTypography.label, { color: theme.color.text.primary }]}>
        {intl.formatMessage(source?.kind === "self-hosted" ? m.remote : m.bundled)}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={intl.formatMessage(m.source)} onPress={() => setSettings(true)} style={styles.control}>
        <Text style={[theme.platformTypography.label, { color: theme.color.accent.blue }]}>{intl.formatMessage(m.source)}</Text>
      </Pressable>
    </MobileMaterial>
    {source ? <WorkspaceSurface key={identity} source={source} dark={dark} onAppearance={setAppearance} />
      : <View style={styles.center}>
        {readError ? <>
          <Text style={{ color: theme.color.text.primary }}>{intl.formatMessage(m.readFailed)}</Text>
          <Pressable accessibilityRole="button" onPress={() => setReadAttempt(value => value + 1)} style={styles.control}>
            <Text style={{ color: theme.color.accent.blue }}>{intl.formatMessage(m.retry)}</Text>
          </Pressable>
        </> : <ActivityIndicator color={theme.color.text.secondary} />}
      </View>}
    {settings && <SourceSettings source={source ?? BUNDLED_SOURCE} dark={dark} onClose={() => setSettings(false)} onSave={save} />}
  </SafeAreaView>;
}

export function MobileShell() {
  return <SafeAreaProvider><IntlRuntimeProvider runtime={mobileLocale}><Shell /></IntlRuntimeProvider></SafeAreaProvider>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, toolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, minHeight: 48 },
  title: { flex: 1 }, control: { minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 8 },
  center: { flex: 1, padding: 24, gap: 16, justifyContent: "center", alignItems: "center" },
});
