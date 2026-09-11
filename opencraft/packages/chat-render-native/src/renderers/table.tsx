import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function NativeTableRenderer({ node, renderNodes }: ChatNodeRendererProps) {
  if (node.kind !== "table") return null;
  return (
    <ScrollView horizontal style={styles.scroller}>
      <View style={styles.table}>
        <View style={[styles.row, styles.header]}>{node.header.map((cell, index) => <View key={`h-${index}`} style={styles.cell}><Text style={styles.headerText}>{renderNodes(cell)}</Text></View>)}</View>
        {node.rows.map((row, rowIndex) => <View key={`r-${rowIndex}`} style={styles.row}>{row.map((cell, cellIndex) => <View key={`c-${cellIndex}`} style={styles.cell}><Text>{renderNodes(cell)}</Text></View>)}</View>)}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroller: { borderColor: theme.color.border.default, borderRadius: theme.radii.lg, borderWidth: StyleSheet.hairlineWidth, marginVertical: 9, maxWidth: "100%" },
  table: { minWidth: 320 },
  row: { borderBottomColor: theme.color.border.soft, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row" },
  header: { backgroundColor: theme.color.surface.subtle },
  cell: { minWidth: 120, paddingHorizontal: 10, paddingVertical: 8 },
  headerText: { fontWeight: "600" },
}));
