import { useState, useSyncExternalStore } from "react";
import { Button, Typography } from "heroui-native";
import { ArrowLeft, Check, ChevronRight, ExternalLink, X } from "lucide-react-native";
import { Linking, Modal, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

import licenseNotices from "../assets/mobile-open-source-licenses.json";
import { mobileLanguageCopy, resolveMobileLanguage, type MobileLanguagePreference } from "../runtime/mobile-language";
import { mobileLanguagePreference } from "../runtime/mobile-language-preference.ios";

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8f7fb" },
  header: { minHeight: 66, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  headerAction: { minWidth: 48, height: 44, borderRadius: 16 },
  headerSpacer: { width: 48 },
  content: { paddingHorizontal: 22, paddingBottom: 46 },
  eyebrow: { color: "#6732c7", letterSpacing: 1.3, marginTop: 17, marginBottom: 8 },
  title: { color: "#21172d", marginBottom: 8 },
  intro: { color: "#716a7d", marginBottom: 28 },
  sectionTitle: { color: "#21172d", marginBottom: 10 },
  card: { backgroundColor: "#fff", borderRadius: 24, padding: 8, borderWidth: 1, borderColor: "#eeeaf3", marginBottom: 20 },
  row: { minHeight: 54, borderRadius: 17, justifyContent: "space-between", paddingHorizontal: 14, backgroundColor: "transparent" },
  rowSelected: { backgroundColor: "#f2ecff" },
  rowContent: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowLabel: { color: "#302638", flexShrink: 1 },
  selectedLabel: { color: "#6327c8" },
  note: { color: "#8b8396", paddingHorizontal: 10, paddingTop: 3, paddingBottom: 8 },
  licenseRow: { paddingVertical: 15, paddingHorizontal: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e9e5ef" },
  licenseName: { color: "#302638", flexShrink: 1 },
  licenseMeta: { color: "#8b8396", marginTop: 4 },
  licenseButton: { borderRadius: 16, marginBottom: 18 },
});

export function MobileSettingsScreen({ region, onClose }: {
  readonly region: LightVelaRegion;
  readonly onClose?: () => void;
}) {
  const [page, setPage] = useState<"settings" | "licenses">("settings");
  const [saveError, setSaveError] = useState(false);
  const { preference } = useSyncExternalStore(
    mobileLanguagePreference.subscribe,
    mobileLanguagePreference.getSnapshot,
    mobileLanguagePreference.getSnapshot,
  );
  const language = resolveMobileLanguage(preference, region);
  const copy = mobileLanguageCopy(language);
  const choices: ReadonlyArray<{ value: MobileLanguagePreference; label: string }> = [
    { value: "system", label: copy.system },
    { value: "zh-CN", label: copy.chinese },
    { value: "en-US", label: copy.english },
  ];
  return (
    <View style={styles.screen}>
      {onClose || page === "licenses" ? (
        <View style={styles.header}>
          {page === "licenses" ? (
            <Button variant="ghost" size="sm" style={styles.headerAction} accessibilityLabel={copy.back} onPress={() => setPage("settings")}>
              <ArrowLeft size={22} color="#302638" />
            </Button>
          ) : <View style={styles.headerSpacer} />}
          <Typography type="body-sm" style={{ color: "#62586d" }}>LIGHTVELA</Typography>
          {onClose ? (
            <Button variant="ghost" size="sm" style={styles.headerAction} accessibilityLabel={copy.close} onPress={onClose}>
              <X size={22} color="#302638" />
            </Button>
          ) : <View style={styles.headerSpacer} />}
        </View>
      ) : null}
        <ScrollView key={page} contentContainerStyle={styles.content}>
          <Typography type="body-xs" style={styles.eyebrow}>OPENCRAFT  /  LIGHTVELA</Typography>
          <Typography.Heading type="h2" style={styles.title}>{page === "licenses" ? copy.licenses : copy.settings}</Typography.Heading>
          <Typography type="body" style={styles.intro}>{page === "licenses" ? copy.licensesIntro : copy.languageDescription}</Typography>
          {page === "settings" ? (
            <>
              <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.language}</Typography.Heading>
              <View style={styles.card}>
                {choices.map(choice => (
                  <Button
                    key={choice.value}
                    variant="ghost"
                    size="md"
                    style={[styles.row, preference === choice.value && styles.rowSelected]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: preference === choice.value }}
                    onPress={() => { setSaveError(false); void mobileLanguagePreference.select(choice.value).catch(() => setSaveError(true)); }}
                  >
                    <View style={styles.rowContent}>
                      <Typography type="body" style={[styles.rowLabel, preference === choice.value && styles.selectedLabel]}>{choice.label}</Typography>
                      {preference === choice.value ? <Check size={19} color="#6327c8" /> : null}
                    </View>
                  </Button>
                ))}
              </View>
              {saveError ? <Typography type="body-sm" style={styles.note}>{copy.saveError}</Typography> : null}
              {region === "cn" ? <Typography type="body-sm" style={styles.note}>{copy.chinaNote}</Typography> : null}
              <Typography.Heading type="h4" style={styles.sectionTitle}>{copy.licenses}</Typography.Heading>
              <View style={styles.card}>
                <Button variant="ghost" size="md" style={styles.row} onPress={() => setPage("licenses")}>
                  <View style={styles.rowContent}>
                    <Typography type="body" style={styles.rowLabel}>{copy.licensesDescription}</Typography>
                    <ChevronRight size={20} color="#8b8396" />
                  </View>
                </Button>
              </View>
            </>
          ) : (
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
          )}
        </ScrollView>
    </View>
  );
}

export function MobileSettingsModal({ visible, onClose, region }: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly region: LightVelaRegion;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        {visible ? <MobileSettingsScreen region={region} onClose={onClose} /> : null}
      </SafeAreaView>
    </Modal>
  );
}
