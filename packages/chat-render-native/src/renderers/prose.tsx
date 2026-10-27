import { nativeTypographyStyle, typographyRole } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import type { ChatDocumentNode } from "@opencraft/chat-document";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { CheckIcon as Check } from "@opencraft/design-system-native/action-icons";
import { createContext, useContext, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "../styles";
import { nativeListMarker, nativeListMarkerColumnWidth } from "./list-marker";
import { splitNativeMediaParagraph } from "./media-paragraph";
import { nativeHeadingSpacing, nativeParagraphSpacing, nativeRuleSpacing } from "./prose-spacing";

const ListMarkerContext = createContext<{ ordered: boolean; start: number | null; index: number; depth: number; markerWidth: number } | null>(null);

function childContent(props: ChatNodeRendererProps): ReactNode {
  return "children" in props.node ? props.renderNodes(props.node.children, props.node.kind) : null;
}

export function NativeProseRenderer(props: ChatNodeRendererProps): ReactNode {
  const { node } = props;
  const listMarker = useContext(ListMarkerContext);
  const paragraphSpacing = nativeParagraphSpacing(props.context.dialect, props.position, node.kind === "paragraph" ? node : undefined);
  switch (node.kind) {
    case "paragraph": return node.children.some(child => child.kind === "image")
      ? <View style={[styles.mediaParagraph, paragraphSpacing]}>{splitNativeMediaParagraph(node.children).map(part => part.kind === "image"
        ? <View key={part.key}>{props.renderNodes([part.node], node.kind)}</View>
        : <Text key={part.key} selectable style={[styles.mediaParagraphText, props.position?.parentKind === "blockquote" && styles.quoteParagraph]}>{props.renderNodes(part.nodes)}</Text>)}</View>
      : <Text selectable style={[styles.paragraph, props.position?.parentKind === "blockquote" && styles.quoteParagraph, paragraphSpacing]}>{childContent(props)}</Text>;
    case "heading": return <Text selectable style={[
      styles.heading,
      nativeHeadingSpacing(props.position, props.context.dialect),
      node.depth === 1 && styles.headingOne,
      node.depth === 2 && styles.headingTwo,
      node.depth >= 5 && styles.headingSmall,
    ]}>{childContent(props)}</Text>;
    case "blockquote": return <View style={styles.blockquote}>{childContent(props)}</View>;
    case "strong": return <Text style={styles.strong}>{childContent(props)}</Text>;
    case "emphasis": return <Text style={styles.emphasis}>{childContent(props)}</Text>;
    case "delete": return <Text style={styles.deleted}>{childContent(props)}</Text>;
    case "root-fragment": return <>{childContent(props)}</>;
    case "line-break": return <Text>{"\n"}</Text>;
    case "horizontal-rule": return <View style={[styles.rule, nativeRuleSpacing(props.position, props.context.dialect)]} />;
    case "list": {
      const markerWidth = nativeListMarkerColumnWidth(node.ordered, node.start, node.children.length);
      return <View style={[styles.list, props.position?.nextSiblingKind === null && styles.lastList, listMarker !== null && styles.nestedList, props.context.dialect === "user-message" && styles.userList]}>{node.children.map((child, index) => (
        <ListMarkerContext.Provider key={child.stableKey} value={{ ordered: node.ordered, start: node.start, index, depth: listMarker === null ? 0 : listMarker.depth + 1, markerWidth }}>
          {props.renderNodes([child], node.kind)}
        </ListMarkerContext.Provider>
      ))}</View>;
    }
    case "list-item": return <View style={styles.listItem}>
      {node.checked === null
        ? <Text style={[styles.bullet, { width: listMarker?.markerWidth ?? 18 }]}>{nativeListMarker(listMarker?.ordered ?? false, listMarker?.start ?? null, listMarker?.index ?? 0, listMarker?.depth ?? 0)}</Text>
        : <View accessibilityRole="checkbox" accessibilityState={{ checked: node.checked, disabled: true }} style={[styles.taskCheckbox, node.checked && styles.taskCheckboxChecked]}>
          {node.checked ? <Check size={10} color={nativeThemes.light.material.content} strokeWidth={1.8} /> : null}
        </View>}
      <View style={styles.listBody}>{childContent(props)}</View>
    </View>;
    case "text": return <Text>{node.segments.map((segment) => <Text key={segment.key}>{segment.text}</Text>)}</Text>;
    case "color-swatch": return <Text>
      {node.segments.map((segment) => <Text key={segment.key}>{segment.text}</Text>)}
      <Text accessibilityLabel={`Color ${node.color}`} style={[styles.colorSwatch, { backgroundColor: node.color }]}>{"\u00a0\u00a0"}</Text>
    </Text>;
    case "inline-code": return <Text style={styles.inlineCode}>{node.code}</Text>;
    case "unknown": return <Text>{node.raw}</Text>;
    default: return null;
  }
}

export const nativeProseNodeKinds: readonly ChatDocumentNode["kind"][] = [
  "paragraph", "heading", "blockquote", "strong", "emphasis", "delete",
  "root-fragment", "line-break", "horizontal-rule", "list", "list-item",
  "text", "color-swatch", "inline-code", "unknown",
];

const styles = StyleSheet.create((theme) => ({
  paragraph: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight, textAlign: "auto", writingDirection: "auto" },
  quoteParagraph: { ...nativeTypographyStyle("chat", Platform.OS) },
  mediaParagraph: { minWidth: 0, maxWidth: "100%" },
  mediaParagraphText: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight, textAlign: "auto", writingDirection: "auto" },
  heading: { color: theme.color.text.primary, ...nativeTypographyStyle("proseHeadingThree", Platform.OS), marginTop: 20, marginBottom: 10, textAlign: "auto", writingDirection: "auto" },
  headingOne: { ...nativeTypographyStyle("proseHeadingOne", Platform.OS), },
  headingTwo: { ...nativeTypographyStyle("proseHeadingTwo", Platform.OS), },
  headingSmall: { ...nativeTypographyStyle("proseHeadingSmall", Platform.OS), },
  blockquote: { borderLeftColor: theme.color.border.strong, borderLeftWidth: 4, marginBottom: 8, paddingVertical: 8, paddingLeft: 24 },
  strong: { fontWeight: typographyRole("proseStrong", "native").fontWeight },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through" },
  rule: { backgroundColor: theme.color.border.strong, height: 1 },
  list: { gap: 8, marginBottom: 10 },
  lastList: { marginBottom: 0 },
  nestedList: { marginTop: 8, marginBottom: 0 },
  userList: { gap: 0, marginTop: 0, marginBottom: 0 },
  listItem: { alignItems: "flex-start", flexDirection: "row", gap: 6 },
  listBody: { flex: 1, minWidth: 0 },
  bullet: { color: theme.color.text.primary, fontSize: theme.platformTypography.chat.fontSize, lineHeight: theme.platformTypography.chat.lineHeight, textAlign: "right" },
  taskCheckbox: { alignItems: "center", justifyContent: "center", width: 14, height: 14, marginTop: 4, borderColor: theme.color.border.strong, borderWidth: 1, borderRadius: 4 },
  taskCheckboxChecked: { borderColor: theme.color.text.primary, backgroundColor: theme.color.text.primary },
  inlineCode: { backgroundColor: theme.color.surface.code, borderRadius: theme.radii.xs, ...nativeTypographyStyle("inlineCode", Platform.OS), paddingHorizontal: 4 },
  colorSwatch: { borderColor: theme.color.border.default, borderWidth: 1, borderRadius: 3, ...nativeTypographyStyle("metadata", Platform.OS), overflow: "hidden" },
}));
