import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function NativeCodeRenderer({ node }: ChatNodeRendererProps) {
  if (node.kind !== "code-fence") return null;
  return (
    <View style={styles.surface}>
      <View style={styles.header}><Text style={styles.label}>{node.language ?? (node.completeness === "open" ? "plaintext" : "Code")}</Text></View>
      <ScrollView horizontal nestedScrollEnabled><Text selectable style={styles.code}>{node.code}</Text></ScrollView>
    </View>
  );
}

export function NativeDiagramFallback(props: ChatNodeRendererProps) {
  const { node } = props;
  if (node.kind !== "code-fence") return null;
  return (
    <View style={styles.diagram}>
      <Text style={styles.diagramTitle}>Mermaid diagram · source preview</Text>
      <NativeCodeRenderer {...props} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { backgroundColor: theme.color.surface.code, borderColor: theme.color.border.default, borderRadius: theme.radii.lg, borderWidth: StyleSheet.hairlineWidth, marginVertical: 9, overflow: "hidden" },
  header: { borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, height: 34, justifyContent: "center", paddingHorizontal: 12 },
  label: { color: theme.color.text.tertiary, fontSize: theme.platformTypography.caption.fontSize },
  code: { color: theme.color.text.primary, fontFamily: "Menlo", fontSize: theme.platformTypography.code.fontSize, lineHeight: theme.platformTypography.code.lineHeight, padding: 12 },
  diagram: { marginVertical: 4 },
  diagramTitle: { color: theme.color.text.secondary, fontSize: theme.platformTypography.label.fontSize, fontWeight: "500" },
}));
