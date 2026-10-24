import { Button } from "heroui-native";
import { KeyboardAvoidingView, Modal, Platform, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";

interface NativeComposerLinkEditorProps {
  visible: boolean;
  language: "zh-CN" | "en";
  address: string;
  canRemove: boolean;
  error: boolean;
  onAddressChange(address: string): void;
  onSave(): void;
  onRemove(): void;
  onDismiss(): void;
}

/** The keyboard owns the lower viewport while this small native sheet is open. */
export function NativeComposerLinkEditor({
  visible, language, address, canRemove, error, onAddressChange, onSave, onRemove, onDismiss,
}: NativeComposerLinkEditorProps) {
  const { theme } = useWorkbenchTheme();
  const label = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
      <SafeAreaView edges={["bottom"]} style={styles.panel}>
        <Text style={styles.title}>{label("添加链接", "Add link")}</Text>
        <Text style={styles.label}>{label("网页地址", "Web address")}</Text>
        <TextInput
          accessibilityLabel={label("网页地址", "Web address")}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="url"
          onChangeText={onAddressChange}
          onSubmitEditing={onSave}
          placeholder="https://"
          placeholderTextColor={theme.color.text.tertiary}
          returnKeyType="done"
          style={styles.input}
          value={address}
        />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{label("请输入有效的网页地址。", "Enter a valid web address.")}</Text> : null}
        <View style={styles.actions}>
          <Button variant="secondary" style={styles.action} onPress={onDismiss}>{label("取消", "Cancel")}</Button>
          {canRemove ? <Button variant="secondary" style={styles.action} onPress={onRemove}>{label("移除链接", "Remove link")}</Button> : null}
          <Button style={styles.action} onPress={onSave}>{label("保存", "Save")}</Button>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create((theme) => ({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: theme.material.scrim },
  panel: {
    paddingHorizontal: theme.spacing[5],
    paddingTop: theme.spacing[5],
    backgroundColor: theme.material.raised,
    borderTopLeftRadius: theme.radii.xxl,
    borderTopRightRadius: theme.radii.xxl,
  },
  title: { marginBottom: theme.spacing[4], color: theme.color.text.primary, ...theme.platformTypography.navigationTitle },
  label: { marginBottom: theme.spacing[2], color: theme.color.text.secondary, ...theme.platformTypography.label },
  input: {
    minHeight: 48,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radii.lg,
    backgroundColor: theme.material.grouped,
    color: theme.color.text.primary,
    ...theme.platformTypography.body,
  },
  error: { marginTop: theme.spacing[2], color: theme.color.accent.negative, ...theme.platformTypography.caption },
  actions: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[5], marginBottom: theme.spacing[3] },
  action: { flex: 1 },
}));
