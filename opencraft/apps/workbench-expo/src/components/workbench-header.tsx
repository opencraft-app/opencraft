import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import {
  Cloud,
  Code2,
  PanelLeftOpen,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import { IconButton } from "./ui/button";

interface WorkbenchHeaderProps {
  thread: WorkbenchThread | undefined;
  hostLabel: string;
  hostPhase: "idle" | "connecting" | "ready" | "reconnecting" | "error" | "disposed";
  sidebarOpen: boolean;
  topInset: number;
  onToggleSidebar(): void;
}

function ToolbarButton({ label, children, active, onPress }: {
  label: string;
  children: ReactNode;
  active?: boolean;
  onPress?(): void;
}) {
  return (
    <IconButton
      accessibilityLabel={label}
      onPress={onPress}
      selected={active}
      size="lg"
    >
      {children}
    </IconButton>
  );
}

export function WorkbenchHeader({
  thread,
  hostLabel,
  hostPhase,
  sidebarOpen,
  topInset,
  onToggleSidebar,
}: WorkbenchHeaderProps) {
  const { theme } = useWorkbenchTheme();
  const secondary = theme.color.icon.secondary;
  const metrics = theme.metrics;

  return (
    <View style={[styles.header, { height: metrics.toolbar.height + topInset, paddingTop: topInset }]}> 
      {!sidebarOpen ? (
        <ToolbarButton label="Show sidebar" onPress={onToggleSidebar}>
          <PanelLeftOpen color={theme.color.accent.blue} size={metrics.control.icon} strokeWidth={1.9} />
        </ToolbarButton>
      ) : null}

      <View style={styles.context}>
        <View style={styles.projectIcon}>
          <Code2 color={secondary} size={metrics.control.icon} strokeWidth={1.9} />
        </View>
        <View style={styles.titleCopy}>
          <Text numberOfLines={1} style={styles.title}>{thread?.title ?? "Untitled task"}</Text>
          <Text numberOfLines={1} style={styles.meta}>{thread?.project ?? "OpenCraft"} · main</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <View accessibilityLabel={`${hostLabel}, ${hostPhase}`} style={styles.hostStatus}>
          <View style={[styles.hostDot, hostPhase === "ready" && styles.hostDotReady, hostPhase === "error" && styles.hostDotError]} />
          <Cloud color={secondary} size={metrics.control.iconSmall} strokeWidth={1.8} />
          <Text numberOfLines={1} style={styles.hostText}>{hostLabel}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.material.content,
    borderBottomWidth: 1,
    borderBottomColor: theme.material.separator,
  },
  context: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  projectIcon: {
    width: theme.metrics.toolbar.projectIcon,
    height: theme.metrics.toolbar.projectIcon,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.metrics.control.radius,
    backgroundColor: theme.material.grouped,
  },
  titleCopy: { minWidth: 0, flexShrink: 1 },
  title: { color: theme.color.text.primary, ...theme.platformTypography.navigationTitle },
  meta: { color: theme.color.text.tertiary, ...theme.platformTypography.navigationMeta },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  hostStatus: {
    height: theme.metrics.toolbar.statusHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radii.full,
    backgroundColor: theme.material.grouped,
  },
  hostDot: {
    width: theme.metrics.control.statusDot,
    height: theme.metrics.control.statusDot,
    borderRadius: theme.radii.full,
    backgroundColor: theme.color.icon.tertiary,
  },
  hostDotReady: { backgroundColor: theme.color.accent.positive },
  hostDotError: { backgroundColor: theme.color.accent.negative },
  hostText: { color: theme.color.text.secondary, ...theme.platformTypography.label },
}));
