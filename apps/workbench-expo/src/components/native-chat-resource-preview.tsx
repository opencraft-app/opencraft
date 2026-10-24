import { nativeTypographyStyle } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { ArrowLeftIcon as ArrowLeft } from "@opencraft/design-system-native/action-icons";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log";
import { decodeNativeChatResourceText } from "../runtime/native-chat-resource";
import { Button } from "./ui/button";

type PreviewState = { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "unavailable" };

export function NativeChatResourcePreview({
  path, title, language, onClose, readFile,
}: {
  readonly path: string;
  readonly title: string;
  readonly language: "zh-CN" | "en";
  readonly onClose: () => void;
  readonly readFile: (path: string, signal: AbortSignal) => Promise<{ readonly dataBase64: string }>;
}) {
  const { theme } = useWorkbenchTheme();
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void readFile(path, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const text = decodeNativeChatResourceText(result.dataBase64);
      setState(text === null ? { status: "unavailable" } : { status: "ready", text });
    }, () => {
      if (controller.signal.aborted) return;
      mobileDeveloperLog.log("chat.resource.read.failed");
      setState({ status: "unavailable" });
    });
    return () => controller.abort();
  }, [path, readFile]);

  const label = language === "zh-CN" ? "返回对话" : "Back to chat";
  return <View style={styles.surface} accessibilityViewIsModal>
    <View style={styles.header}>
      <Button accessibilityLabel={label} onPress={onClose} variant="ghost">
        <ArrowLeft size={21} color={theme.color.text.primary} />
      </Button>
      <Text numberOfLines={1} style={styles.title}>{title.split("/").at(-1) || title}</Text>
    </View>
    {state.status === "loading"
      ? <View style={styles.feedback}><ActivityIndicator color={theme.color.text.secondary} /></View>
      : state.status === "unavailable"
        ? <View style={styles.feedback}><Text style={styles.message}>{language === "zh-CN" ? "暂时无法预览此文件。" : "This file cannot be previewed right now."}</Text></View>
        : <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text selectable style={styles.path}>{title}</Text>
          <Text selectable style={styles.fileText}>{state.text}</Text>
        </ScrollView>}
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  surface: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 200, backgroundColor: theme.material.content },
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingHorizontal: theme.spacing[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border.default },
  title: { flex: 1, color: theme.color.text.primary, ...theme.platformTypography.label },
  body: { flex: 1 },
  bodyContent: { padding: theme.spacing[4], gap: theme.spacing[3] },
  path: { color: theme.color.text.secondary, ...theme.platformTypography.label },
  fileText: { color: theme.color.text.primary, ...nativeTypographyStyle("proseCode", Platform.OS) },
  feedback: { flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing[4] },
  message: { color: theme.color.text.secondary, ...theme.platformTypography.body },
}));
