import type { ChatDocumentNode } from "@opencraft/chat-document";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

function childContent(props: ChatNodeRendererProps): ReactNode {
  return "children" in props.node ? props.renderNodes(props.node.children) : null;
}

export function NativeProseRenderer(props: ChatNodeRendererProps): ReactNode {
  const { node } = props;
  switch (node.kind) {
    case "paragraph": return <Text selectable style={styles.paragraph}>{childContent(props)}</Text>;
    case "heading": return <Text selectable style={[styles.heading, node.depth <= 2 && styles.headingLarge]}>{childContent(props)}</Text>;
    case "blockquote": return <View style={styles.blockquote}><Text style={styles.secondary}>{childContent(props)}</Text></View>;
    case "strong": return <Text style={styles.strong}>{childContent(props)}</Text>;
    case "emphasis": return <Text style={styles.emphasis}>{childContent(props)}</Text>;
    case "delete": return <Text style={styles.deleted}>{childContent(props)}</Text>;
    case "root-fragment": return <>{childContent(props)}</>;
    case "line-break": return <Text>{"\n"}</Text>;
    case "horizontal-rule": return <View style={styles.rule} />;
    case "list": return <View style={styles.list}>{childContent(props)}</View>;
    case "list-item": return <View style={styles.listItem}><Text style={styles.bullet}>{node.checked === null ? "•" : node.checked ? "☑" : "☐"}</Text><View style={styles.listBody}>{childContent(props)}</View></View>;
    case "text":
    case "reference":
    case "color-swatch": return <Text>{node.segments.map((segment) => <Text key={segment.key}>{segment.text}</Text>)}</Text>;
    case "inline-code": return <Text style={styles.inlineCode}>{node.code}</Text>;
    case "unknown": return <Text>{node.raw}</Text>;
    default: return null;
  }
}

export const nativeProseNodeKinds: readonly ChatDocumentNode["kind"][] = [
  "paragraph", "heading", "blockquote", "strong", "emphasis", "delete",
  "root-fragment", "line-break", "horizontal-rule", "list", "list-item",
  "text", "reference", "color-swatch", "inline-code", "unknown",
];

const styles = StyleSheet.create((theme) => ({
  paragraph: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight, marginBottom: 10 },
  heading: { color: theme.color.text.primary, fontSize: 18, lineHeight: 24, fontWeight: "600", marginTop: 12, marginBottom: 7 },
  headingLarge: { fontSize: 22, lineHeight: 28 },
  secondary: { color: theme.color.text.secondary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight },
  blockquote: { borderLeftColor: theme.color.border.strong, borderLeftWidth: 2, marginVertical: 8, paddingLeft: 12 },
  strong: { fontWeight: "600" },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through" },
  rule: { backgroundColor: theme.color.border.default, height: StyleSheet.hairlineWidth, marginVertical: 14 },
  list: { gap: 5, marginBottom: 10 },
  listItem: { alignItems: "flex-start", flexDirection: "row", gap: 8 },
  listBody: { flex: 1, minWidth: 0 },
  bullet: { color: theme.color.text.tertiary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight },
  inlineCode: { backgroundColor: theme.color.surface.code, borderRadius: theme.radii.xs, fontFamily: "Menlo", fontSize: theme.platformTypography.code.fontSize, paddingHorizontal: 4 },
}));
