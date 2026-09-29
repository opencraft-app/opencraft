import type { WorkbenchFileChange } from "@opencraft/workbench-runtime";
import { Check, FileCode2, X } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import { Button, IconButton } from "./ui/button";

interface WorkbenchRightPanelProps {
  files: readonly WorkbenchFileChange[];
  topInset: number;
  onClose(): void;
}

export function WorkbenchRightPanel({ files, topInset, onClose }: WorkbenchRightPanelProps) {
  const { theme } = useWorkbenchTheme();
  return (
    <View style={[styles.panel, { paddingTop: topInset }]}> 
      <View style={styles.header}>
        <Text style={styles.title}>Changes</Text>
        <IconButton accessibilityLabel="Close task details" onPress={onClose} size="lg">
          <X color={theme.color.icon.secondary} size={theme.metrics.control.icon} strokeWidth={1.8} />
        </IconButton>
      </View>
      <ScrollView contentContainerStyle={styles.fileList} showsVerticalScrollIndicator={false}>
        {files.map((file) => (
          <View key={file.path} style={styles.fileRow}>
            <FileCode2 color={theme.color.icon.tertiary} size={theme.metrics.control.icon} strokeWidth={1.8} />
            <Text numberOfLines={1} style={styles.filePath}>{file.path}</Text>
            <Text style={styles.additions}>+{file.additions}</Text>
            <Text style={styles.deletions}>−{file.deletions}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <Button size="lg" style={styles.reviewButton}>
          <Check color={theme.color.button.primaryForeground} size={theme.metrics.control.iconSmall} strokeWidth={2} />
          <Text style={styles.reviewButtonText}>Review changes</Text>
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    width: theme.metrics.details.width,
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.metrics.details.surfaceRadius,
    backgroundColor: theme.material.raised,
    borderWidth: 1,
    borderColor: theme.material.separator,
  },
  header: {
    height: theme.metrics.toolbar.height,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
  },
  title: { color: theme.color.text.primary, ...theme.platformTypography.navigationTitle },
  fileList: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[4] },
  fileRow: {
    minHeight: theme.metrics.details.fileRowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.metrics.control.radius,
  },
  filePath: { flex: 1, color: theme.color.text.secondary, ...theme.platformTypography.code },
  additions: { color: theme.color.accent.positive, ...theme.platformTypography.code },
  deletions: { color: theme.color.accent.negative, ...theme.platformTypography.code },
  footer: { padding: theme.spacing[3], borderTopWidth: 1, borderTopColor: theme.material.separator },
  reviewButton: {
    width: "100%",
  },
  reviewButtonText: { color: theme.color.button.primaryForeground, ...theme.platformTypography.label },
}));
