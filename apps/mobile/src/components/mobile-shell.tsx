import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { actionArtwork } from "@opencraft/design-system/action-artwork";
import { ipadMetrics, nativeThemes } from "@opencraft/design-system/tokens.native";
import { IntlRuntimeProvider, useIntl } from "@opencraft/i18n/react";
import Svg, { Path } from "react-native-svg";
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
  const [ready, setReady] = useState(false);
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
    if (source && encodeContentSource(next) === encodeContentSource(source)) { setSettings(false); return; }
    ++readGeneration.current;
    setSource(next); setAppearance(null); setReadError(false); setSettings(false); setReady(false);
  };
  const identity = source?.kind === "self-hosted" ? source.url : "bundled";
  // WKWebView gives the website a full-screen canvas and reports its safe areas.
  const websiteOwnsInsets = Platform.OS === "ios" && source?.kind === "self-hosted";
  const sourceLabel = intl.formatMessage(m.source);
  return <SafeAreaView edges={websiteOwnsInsets ? [] : undefined} style={[styles.root, { backgroundColor: source?.kind === "bundled" && appearance ? appearance.edgeBackgroundColor : theme.material.content }]}>
    <StatusBar style={dark ? "light" : "dark"} />
    {!websiteOwnsInsets && (!ready || source?.kind !== "bundled") && <MobileMaterial backgroundColor={theme.material.raised} style={styles.toolbar}>
      <Text numberOfLines={1} style={[styles.title, theme.platformTypography.label, { color: theme.color.text.primary }]}>
        {intl.formatMessage(source?.kind === "self-hosted" ? m.remote : m.brand)}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={sourceLabel} onPress={() => setSettings(true)} style={styles.control}>
        <Text style={[theme.platformTypography.label, { color: theme.color.accent.blue }]}>{sourceLabel}</Text>
      </Pressable>
    </MobileMaterial>}
    {source ? <WorkspaceSurface key={identity} source={source} dark={dark} onAppearance={setAppearance} onReady={setReady} onSourceSettings={() => setSettings(true)} />
      : <View style={styles.center}>
        {readError ? <>
          <Text style={{ color: theme.color.text.primary }}>{intl.formatMessage(m.readFailed)}</Text>
          <Pressable accessibilityRole="button" onPress={() => setReadAttempt(value => value + 1)} style={styles.control}>
            <Text style={{ color: theme.color.accent.blue }}>{intl.formatMessage(m.retry)}</Text>
          </Pressable>
        </> : <ActivityIndicator color={theme.color.text.secondary} />}
      </View>}
    {websiteOwnsInsets && <SafeAreaView edges={["right"]} pointerEvents="box-none" style={styles.sourceOverlay}>
      <MobileMaterial backgroundColor={theme.material.raised} style={styles.sourceMaterial}>
        <Pressable accessibilityRole="button" accessibilityLabel={sourceLabel} onPress={() => setSettings(true)}
          style={({ pressed }) => [styles.sourceButton, pressed && styles.sourcePressed]}>
          <Svg width={ipadMetrics.control.icon} height={ipadMetrics.control.icon} viewBox="0 0 24 24" accessibilityElementsHidden>
            <Path d={actionArtwork.LinkIcon.shapes[0].attributes.d} fill="none" stroke={theme.color.text.primary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </Pressable>
      </MobileMaterial>
    </SafeAreaView>}
    {settings && <SourceSettings source={source ?? BUNDLED_SOURCE} dark={dark} onClose={() => setSettings(false)} onSave={save} />}
  </SafeAreaView>;
}

export function MobileShell() {
  return <SafeAreaProvider><IntlRuntimeProvider runtime={mobileLocale}><Shell /></IntlRuntimeProvider></SafeAreaProvider>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, toolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, minHeight: 48 },
  title: { flex: 1 }, control: { minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 8 },
  sourceOverlay: { position: "absolute", right: 0, top: "50%", paddingRight: 8, transform: [{ translateY: -ipadMetrics.toolbar.touchTarget / 2 }] },
  sourceMaterial: { borderRadius: ipadMetrics.toolbar.touchTarget / 2 },
  sourceButton: { width: ipadMetrics.toolbar.touchTarget, height: ipadMetrics.toolbar.touchTarget, alignItems: "center", justifyContent: "center" },
  sourcePressed: { opacity: ipadMetrics.interaction.pressedOpacity },
  center: { flex: 1, padding: 24, gap: 16, justifyContent: "center", alignItems: "center" },
});
