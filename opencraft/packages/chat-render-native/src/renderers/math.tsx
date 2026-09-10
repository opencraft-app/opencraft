import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { ScrollView, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function NativeMathFallback({ node }: ChatNodeRendererProps) {
  if (node.kind !== "math") return null;
  const source = node.display ? `$$${node.source}$$` : `$${node.source}$`;
  if (!node.display) return <Text style={styles.inline}>{source}</Text>;
  return <ScrollView horizontal style={styles.display}><Text selectable style={styles.inline}>{source}</Text></ScrollView>;
}

const styles = StyleSheet.create((theme) => ({
  inline: { color: theme.color.text.secondary, fontFamily: "Menlo", fontSize: theme.platformTypography.code.fontSize },
  display: { marginVertical: 9, maxWidth: "100%" },
}));
