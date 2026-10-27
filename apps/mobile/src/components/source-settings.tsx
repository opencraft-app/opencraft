import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { useIntl } from "@opencraft/i18n/react";
import { BUNDLED_SOURCE, selfHostedSource, type MobileContentSource } from "../runtime/content-source";
import { mobileMessages as m } from "../runtime/mobile-messages";

export function SourceSettings({ source, dark, onClose, onSave }: {
  source: MobileContentSource; dark: boolean; onClose(): void; onSave(source: MobileContentSource): Promise<void>;
}) {
  const intl = useIntl();
  const theme = nativeThemes[dark ? "dark" : "light"];
  const [remote, setRemote] = useState(source.kind === "self-hosted");
  const [url, setUrl] = useState(source.kind === "self-hosted" ? source.url : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"invalid" | "saveFailed" | null>(null);
  const save = async () => {
    let next: MobileContentSource;
    try { next = remote ? selfHostedSource(url) : BUNDLED_SOURCE; } catch { setError("invalid"); return; }
    setError(null); setPending(true);
    try { await onSave(next); } catch { setError("saveFailed"); setPending(false); }
  };
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!pending) onClose(); }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.material.content }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={[theme.platformTypography.navigationTitle, { color: theme.color.text.primary }]}>{intl.formatMessage(m.source)}</Text>
        <Text style={[theme.platformTypography.body, { color: theme.color.text.secondary }]}>{intl.formatMessage(m.description)}</Text>
        <View style={styles.row}>
          <Text style={[theme.platformTypography.body, styles.label, { color: theme.color.text.primary }]}>{intl.formatMessage(m.consent)}</Text>
          <Switch accessibilityLabel={intl.formatMessage(m.consent)} value={remote} disabled={pending} onValueChange={setRemote} />
        </View>
        {remote && <>
          <Text style={[theme.platformTypography.label, { color: theme.color.text.primary }]}>{intl.formatMessage(m.url)}</Text>
          <TextInput accessibilityLabel={intl.formatMessage(m.url)} value={url} editable={!pending} onChangeText={setUrl}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL"
            style={[styles.input, theme.platformTypography.body, { color: theme.color.text.primary, borderColor: theme.color.border.default }]} />
          <Text style={[theme.platformTypography.body, { color: theme.color.text.secondary }]}>{intl.formatMessage(m.privacy)}</Text>
        </>}
        {error && <Text accessibilityRole="alert" style={{ color: theme.color.text.primary }}>{intl.formatMessage(m[error])}</Text>}
        <Pressable disabled={pending} accessibilityRole="button" accessibilityState={{ disabled: pending, busy: pending }} onPress={() => { void save(); }}
          style={[styles.action, { backgroundColor: theme.color.button.primary }]}>
          <Text style={[theme.platformTypography.label, { color: theme.color.button.primaryForeground }]}>{intl.formatMessage(m.apply)}</Text>
        </Pressable>
        <Pressable disabled={pending} accessibilityRole="button" onPress={onClose} style={styles.action}>
          <Text style={[theme.platformTypography.label, { color: theme.color.text.secondary }]}>{intl.formatMessage(m.cancel)}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  content: { padding: 24, gap: 20, maxWidth: 640, width: "100%", alignSelf: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 16 }, label: { flex: 1 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
  action: { minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", padding: 12 },
});
