import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Typography } from "heroui-native";
import { ArrowLeft, Check, ChevronRight, ExternalLink, X } from "lucide-react-native";
import { Linking, Modal, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { nativeTokens } from "@opencraft/design-system/tokens.native";

import licenseNotices from "../assets/mobile-open-source-licenses.json";
import { mobileLanguageCopy, resolveMobileLanguage, type MobileLanguagePreference } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";
import { mobileDeveloperLog, mobileDeveloperMode } from "../runtime/mobile-developer-log.ios";
import { NativeNavigationSurface } from "./native-navigation-surface.ios";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: nativeTokens.material.canvas },
  header: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  headerAction: { minWidth: 48, height: 44, borderRadius: 14 },
  headerSpacer: { width: 48 },
  content: { paddingHorizontal: 20, paddingBottom: 46 },
  eyebrow: { color: nativeTokens.color.text.tertiary, letterSpacing: 0.7, marginTop: 12, marginBottom: 8 },
  title: { color: nativeTokens.color.text.primary, marginBottom: 8 },
  intro: { color: nativeTokens.color.text.secondary, marginBottom: 24 },
  sectionTitle: { color: nativeTokens.color.text.primary, marginBottom: 10 },
  card: { backgroundColor: nativeTokens.material.content, borderRadius: 20, padding: 6, borderWidth: 1, borderColor: nativeTokens.color.border.soft, marginBottom: 18 },
  row: { minHeight: 52, borderRadius: 14, justifyContent: "space-between", paddingHorizontal: 14, backgroundColor: "transparent" },
  rowSelected: { backgroundColor: nativeTokens.material.grouped },
  rowContent: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: nativeTokens.color.text.primary, flexShrink: 1 },
  selectedLabel: { color: nativeTokens.color.accent.purple },
  note: { color: nativeTokens.color.text.tertiary, paddingHorizontal: 10, paddingTop: 3, paddingBottom: 8 },
  licenseRow: { paddingVertical: 15, paddingHorizontal: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: nativeTokens.material.separator },
  licenseName: { color: nativeTokens.color.text.primary, flexShrink: 1 },
  licenseMeta: { color: nativeTokens.color.text.tertiary, marginTop: 4 },
  licenseButton: { borderRadius: 16, marginBottom: 18 },
  logLine: { color: nativeTokens.color.text.secondary, paddingHorizontal: 12, paddingVertical: 6, fontVariant: ["tabular-nums"] },
  inline: { marginTop: 28 },
});

function SettingsHomeControls({ region, onRegionChange, onLicenses, onLog }: {
  readonly region: LightVelaRegion;
  readonly onRegionChange?: (region: LightVelaRegion) => Promise<void>;
  readonly onLicenses: () => void;
  readonly onLog: () => void;
}) {
  const [saveError, setSaveError] = useState(false);
  const [regionError, setRegionError] = useState(false);
  const developerEnabled = useSyncExternalStore(mobileDeveloperMode.subscribe, mobileDeveloperMode.getSnapshot, mobileDeveloperMode.getSnapshot);
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  useEffect(() => { void mobileDeveloperMode.initialize(); }, []);
  const copy = mobileLanguageCopy(resolveMobileLanguage(preference, region));
  const choices: ReadonlyArray<{ value: MobileLanguagePreference; label: string }> = [
    { value: "system", label: copy.system },
    { value: "zh-CN", label: copy.chinese },
    { value: "en-US", label: copy.english },
  ];
  return <>
    <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.language}</Typography.Heading>
    <View style={styles.card}>
      {choices.map(choice => <Button key={choice.value} variant="ghost" size="md" style={[styles.row, preference === choice.value && styles.rowSelected]}
        accessibilityRole="radio" accessibilityState={{ selected: preference === choice.value }}
        onPress={() => { setSaveError(false); void mobileLanguagePreference.select(choice.value).catch(() => setSaveError(true)); }}>
        <View style={styles.rowContent}>
          <Typography type="body" style={[styles.rowLabel, preference === choice.value && styles.selectedLabel]}>{choice.label}</Typography>
          {preference === choice.value ? <Check size={19} color={nativeTokens.color.accent.purple} /> : null}
        </View>
      </Button>)}
    </View>
    {saveError ? <Typography type="body-sm" style={styles.note}>{copy.saveError}</Typography> : null}
    {region === "cn" ? <Typography type="body-sm" style={styles.note}>{copy.chinaNote}</Typography> : null}
    <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.licenses}</Typography.Heading>
    <View style={styles.card}>
      <Button variant="ghost" size="md" style={styles.row} onPress={onLicenses}>
        <View style={styles.rowContent}>
          <Typography type="body" style={styles.rowLabel}>{copy.licensesDescription}</Typography>
          <ChevronRight size={20} color={nativeTokens.color.icon.tertiary} />
        </View>
      </Button>
    </View>
    <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.developerMode}</Typography.Heading>
    <View style={styles.card}>
      <Button variant="ghost" size="md" style={[styles.row, developerEnabled && styles.rowSelected]}
        accessibilityRole="switch" accessibilityState={{ checked: developerEnabled }}
        onPress={() => { void mobileDeveloperMode.setEnabled(!developerEnabled).catch(() => setSaveError(true)); }}>
        <View style={styles.rowContent}>
          <Typography type="body" style={styles.rowLabel}>{copy.developerMode}</Typography>
          {developerEnabled ? <Check size={19} color={nativeTokens.color.accent.purple} /> : null}
        </View>
      </Button>
      {developerEnabled ? <Button variant="ghost" size="md" style={styles.row} onPress={onLog}>
        <View style={styles.rowContent}>
          <Typography type="body" style={styles.rowLabel}>{copy.diagnosticLog}</Typography>
          <ChevronRight size={20} color={nativeTokens.color.icon.tertiary} />
        </View>
      </Button> : null}
    </View>
    <Typography type="body-sm" style={styles.note}>{copy.developerModeDescription}</Typography>
    {developerEnabled ? <>
      <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.chooseRegion}</Typography.Heading>
      <View style={styles.card}>
        {(["cn", "intl"] as const).map(value => <Button key={value} variant="ghost" size="md"
          style={[styles.row, region === value && styles.rowSelected]}
          accessibilityRole="radio" accessibilityState={{ selected: region === value, disabled: !onRegionChange }}
          isDisabled={!onRegionChange}
          onPress={() => {
            if (value === region || !onRegionChange) return;
            setRegionError(false);
            void onRegionChange(value).catch(() => setRegionError(true));
          }}>
          <View style={styles.rowContent}>
            <Typography type="body" style={[styles.rowLabel, region === value && styles.selectedLabel]}>{value === "cn" ? copy.chinaRegion : copy.internationalRegion}</Typography>
            {region === value ? <Check size={19} color={nativeTokens.color.accent.purple} /> : null}
          </View>
        </Button>)}
      </View>
      {!onRegionChange ? <Typography type="body-sm" style={styles.note}>{copy.regionSwitchSignOut}</Typography> : null}
      {regionError ? <Typography type="body-sm" style={styles.note}>{copy.regionSwitchError}</Typography> : null}
    </> : null}
  </>;
}

export function MobileSettingsScreen({ region, onRegionChange, onClose, onNestedPageChange, initialPage = "settings" }: {
  readonly region: LightVelaRegion;
  readonly onRegionChange?: (region: LightVelaRegion) => Promise<void>;
  readonly onClose?: () => void;
  readonly onNestedPageChange?: (open: boolean) => void;
  readonly initialPage?: "settings" | "licenses" | "log";
}) {
  const [page, setPage] = useState<"settings" | "licenses" | "log">(initialPage);
  useEffect(() => { onNestedPageChange?.(initialPage === "settings" && page !== "settings"); }, [initialPage, onNestedPageChange, page]);
  const developerEnabled = useSyncExternalStore(mobileDeveloperMode.subscribe, mobileDeveloperMode.getSnapshot, mobileDeveloperMode.getSnapshot);
  const logLines = useSyncExternalStore(mobileDeveloperLog.subscribe, mobileDeveloperLog.getSnapshot, mobileDeveloperLog.getSnapshot);
  useEffect(() => { void mobileDeveloperMode.initialize(); }, []);
  const { preference } = useSyncExternalStore(
    mobileLanguagePreference.subscribe,
    mobileLanguagePreference.getSnapshot,
    mobileLanguagePreference.getSnapshot,
  );
  const language = resolveMobileLanguage(preference, region);
  const copy = mobileLanguageCopy(language);
  const renderPage = (currentPage: "settings" | "licenses" | "log", onBack?: () => void) => (
    <View style={styles.screen}>
      {onClose || currentPage !== "settings" ? (
        <View style={styles.header}>
          {currentPage !== "settings" ? (
            <Button variant="ghost" size="sm" style={styles.headerAction} accessibilityLabel={copy.back} onPress={onBack}>
              <ArrowLeft size={22} color={nativeTokens.color.icon.primary} />
            </Button>
          ) : <View style={styles.headerSpacer} />}
          <Typography type="body-sm" style={{ color: nativeTokens.color.text.secondary }}>LIGHTVELA</Typography>
          {onClose ? (
            <Button variant="ghost" size="sm" style={styles.headerAction} accessibilityLabel={copy.close} onPress={onClose}>
              <X size={22} color={nativeTokens.color.icon.primary} />
            </Button>
          ) : <View style={styles.headerSpacer} />}
        </View>
      ) : null}
        <ScrollView key={currentPage} contentContainerStyle={styles.content}>
          <Typography type="body-xs" style={styles.eyebrow}>OPENCRAFT  /  LIGHTVELA</Typography>
          <Typography.Heading type="h2" style={styles.title}>{currentPage === "licenses" ? copy.licenses : currentPage === "log" ? copy.diagnosticLog : copy.settings}</Typography.Heading>
          <Typography type="body" style={styles.intro}>{currentPage === "licenses" ? copy.licensesIntro : currentPage === "log" ? copy.diagnosticLogDescription : copy.languageDescription}</Typography>
          {currentPage === "settings" ? (
            <SettingsHomeControls region={region} onRegionChange={onRegionChange} onLicenses={() => setPage("licenses")} onLog={() => setPage("log")} />
          ) : currentPage === "licenses" ? (
            <>
              <Button variant="secondary" style={styles.licenseButton} onPress={() => { void Linking.openURL("https://lightvela.ai/open-source-licenses").catch(() => undefined); }}>
                {copy.fullNotice} <ExternalLink size={17} />
              </Button>
              <View style={styles.card}>
                {licenseNotices.map(notice => (
                  <View key={notice.name} style={styles.licenseRow}>
                    <Typography type="body" style={styles.licenseName}>{notice.name}</Typography>
                    <Typography type="body-sm" style={styles.licenseMeta}>{notice.version} · {notice.license}</Typography>
                    <Button variant="ghost" size="sm" accessibilityLabel={`${copy.open} ${notice.name}`} onPress={() => {
                      void Linking.openURL(`https://www.npmjs.com/package/${notice.name}`).catch(() => undefined);
                    }}>{copy.open} <ExternalLink size={14} /></Button>
                  </View>
                ))}
              </View>
            </>
          ) : developerEnabled ? (
            <>
              <View style={styles.card}>
                {logLines.length ? logLines.map((line, index) => (
                  <Typography key={`${line.time}-${index}`} type="body-xs" style={styles.logLine} selectable>
                    {line.time}  {line.event}{line.facts ? ` ${JSON.stringify(line.facts)}` : ""}
                  </Typography>
                )) : <Typography type="body-sm" style={styles.note}>{copy.diagnosticLogEmpty}</Typography>}
              </View>
              <Button variant="secondary" onPress={() => mobileDeveloperLog.clear()}>{copy.clearLog}</Button>
            </>
          ) : null}
        </ScrollView>
    </View>
  );
  return <View style={styles.screen}>
    {renderPage(initialPage, onClose)}
    {initialPage === "settings" && page !== "settings" ? (
      <NativeNavigationSurface onDismiss={() => setPage("settings")}>
        {dismiss => renderPage(page, dismiss)}
      </NativeNavigationSurface>
    ) : null}
  </View>;
}

export function MobileSettingsInline({ region }: { readonly region: LightVelaRegion }) {
  const [detailPage, setDetailPage] = useState<"licenses" | "log" | null>(null);
  const { preference } = useSyncExternalStore(mobileLanguagePreference.subscribe, mobileLanguagePreference.getSnapshot, mobileLanguagePreference.getSnapshot);
  const copy = mobileLanguageCopy(resolveMobileLanguage(preference, region));
  return <View style={styles.inline}>
    <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.settings}</Typography.Heading>
    <SettingsHomeControls region={region} onLicenses={() => setDetailPage("licenses")} onLog={() => setDetailPage("log")} />
    {detailPage ? <MobileSettingsModal visible onClose={() => setDetailPage(null)} region={region} initialPage={detailPage} /> : null}
  </View>;
}

export function MobileSettingsModal({ visible, onClose, region, onRegionChange, initialPage = "settings" }: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly region: LightVelaRegion;
  readonly onRegionChange?: (region: LightVelaRegion) => Promise<void>;
  readonly initialPage?: "settings" | "licenses" | "log";
}) {
  const [nestedPageOpen, setNestedPageOpen] = useState(false);
  return (
    <Modal visible={visible} transparent animationType="none" presentationStyle="overFullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        {visible ? <NativeNavigationSurface adaptive onDismiss={onClose} gestureEnabled={!nestedPageOpen}>
          {(dismiss, presentation) => <SafeAreaView edges={presentation === "panel" ? [] : undefined} style={styles.screen}>
            <MobileSettingsScreen region={region} onRegionChange={onRegionChange} onClose={dismiss} onNestedPageChange={setNestedPageOpen} initialPage={initialPage} />
          </SafeAreaView>}
        </NativeNavigationSurface> : null}
      </View>
    </Modal>
  );
}
