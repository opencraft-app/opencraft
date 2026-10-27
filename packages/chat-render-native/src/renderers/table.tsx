import { nativeTypographyStyle, typographyRole } from "@opencraft/design-system/typography";
import { Platform } from "react-native";
import type { ChatDocumentNode } from "@opencraft/chat-document";
import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  ExpandIcon as Expand,
  CloseIcon as X,
} from "@opencraft/design-system-native/action-icons";
import { useState } from "react";
import { Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "../styles";
import { useNativeHorizontalOverflowTouchOwner } from "../horizontal-scroll-owner";
import { useNativeChatCopy } from "../presentation-language";
import { nativeTableColumnWidth } from "./table-layout";
import { useCopyFeedback } from "./use-copy-feedback";

type TableNode = Extract<ChatDocumentNode, { kind: "table" }>;

function TableContents({ node, renderNodes, viewportWidth }: {
  readonly node: TableNode;
  readonly renderNodes: ChatNodeRendererProps["renderNodes"];
  readonly viewportWidth: number;
}) {
  const columnCount = node.rows.reduce((count, row) => Math.max(count, row.length), Math.max(1, node.header.length));
  const columnWidth = nativeTableColumnWidth(viewportWidth, columnCount);
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  return <View style={{ width: columnWidth * columnCount }}>
    <View style={[styles.row, styles.header]}>{columns.map(index => (
      <View key={`h-${index}`} style={[styles.cell, { width: columnWidth }]}>
        <Text selectable style={[styles.headerText, { textAlign: node.align[index] ?? "auto" }]}>{renderNodes(node.header[index] ?? [])}</Text>
      </View>
    ))}</View>
    {node.rows.map((row, rowIndex) => <View key={`r-${rowIndex}`} style={styles.row}>{columns.map(index => (
      <View key={`c-${index}`} style={[styles.cell, { width: columnWidth }]}>
        <Text selectable style={[styles.bodyText, { textAlign: node.align[index] ?? "auto" }]}>{renderNodes(row[index] ?? [])}</Text>
      </View>
    ))}</View>)}
  </View>;
}

function TablePreview({ node, renderNodes, onClose }: {
  readonly node: TableNode;
  readonly renderNodes: ChatNodeRendererProps["renderNodes"];
  readonly onClose: () => void;
}) {
  const copy = useNativeChatCopy();
  const [viewportWidth, setViewportWidth] = useState(0);
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}
    supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]}>
    <SafeAreaView style={styles.preview}>
      <View style={styles.previewToolbar}>
        <Text style={styles.previewTitle}>{copy.tablePreview}</Text>
        <Pressable accessibilityLabel={copy.closeTablePreview} accessibilityRole="button" onPress={onClose} style={styles.previewAction}>
          <X size={20} color={actionColor} />
        </Pressable>
      </View>
      <ScrollView style={styles.previewVertical} contentContainerStyle={styles.previewContent}>
        <ScrollView horizontal nestedScrollEnabled onLayout={event => {
          const next = event.nativeEvent.layout.width;
          setViewportWidth(current => Math.abs(current - next) > 1 ? next : current);
        }}>
          <TableContents node={node} renderNodes={renderNodes} viewportWidth={viewportWidth} />
        </ScrollView>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

export function NativeTableRenderer({ node, renderNodes }: ChatNodeRendererProps) {
  const horizontalScrollOwner = useNativeHorizontalOverflowTouchOwner(node.kind === "table" ? node.markdownSource : "");
  const copyLabels = useNativeChatCopy();
  const [viewportWidth, setViewportWidth] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const { copied, copy } = useCopyFeedback(node.kind === "table" ? node.markdownSource : "", 1_200);
  if (node.kind !== "table") return null;
  return (
    <View style={styles.surface}>
      <View style={styles.toolbar}>
        <Pressable accessibilityLabel={copyLabels.expandTable} accessibilityRole="button" onPress={() => setPreviewOpen(true)} style={styles.action}>
          <Expand size={16} color={actionColor} />
        </Pressable>
        <Pressable accessibilityLabel={copied ? copyLabels.copiedTable : copyLabels.copyTable} accessibilityRole="button" onPress={copy} style={styles.action}>
          {copied ? <Check size={16} color={actionColor} /> : <Copy size={16} color={actionColor} />}
        </Pressable>
      </View>
      <ScrollView horizontal nestedScrollEnabled scrollEnabled={horizontalScrollOwner.scrollEnabled}
        onTouchStart={horizontalScrollOwner.beginTouch} onTouchEnd={horizontalScrollOwner.endTouch} onTouchCancel={horizontalScrollOwner.endTouch}
        onContentSizeChange={width => horizontalScrollOwner.setContentWidth(width)} onLayout={event => {
        const next = event.nativeEvent.layout.width;
        horizontalScrollOwner.setViewportWidth(next);
        setViewportWidth(current => Math.abs(current - next) > 1 ? next : current);
      }} style={styles.scroller}>
        <TableContents node={node} renderNodes={renderNodes} viewportWidth={viewportWidth} />
      </ScrollView>
      {previewOpen ? <TablePreview node={node} renderNodes={renderNodes} onClose={() => setPreviewOpen(false)} /> : null}
    </View>
  );
}

const actionColor = nativeThemes.light.color.text.tertiary;

const styles = StyleSheet.create((theme) => ({
  surface: { borderColor: theme.color.border.default, borderRadius: theme.radii.lg, borderWidth: StyleSheet.hairlineWidth, marginVertical: 9, maxWidth: "100%", minWidth: 0, overflow: "hidden" },
  toolbar: { alignItems: "center", borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "flex-end", minHeight: 32, paddingHorizontal: 4 },
  action: { alignItems: "center", borderRadius: theme.radii.sm, height: 30, justifyContent: "center", width: 30 },
  scroller: { maxWidth: "100%", minWidth: 0 },
  row: { borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row" },
  header: { backgroundColor: theme.color.surface.subtle },
  cell: { paddingHorizontal: 10, paddingVertical: 8 },
  headerText: { color: theme.color.text.primary, fontWeight: typographyRole("proseStrong", "native").fontWeight, writingDirection: "auto" },
  bodyText: { color: theme.color.text.primary, writingDirection: "auto" },
  preview: { flex: 1, backgroundColor: theme.color.surface.main },
  previewToolbar: { alignItems: "center", borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, minHeight: 52 },
  previewTitle: { color: theme.color.text.primary, ...nativeTypographyStyle("panelTitle", Platform.OS) },
  previewAction: { alignItems: "center", justifyContent: "center", height: 44, width: 44 },
  previewVertical: { flex: 1 },
  previewContent: { padding: 16 },
}));
