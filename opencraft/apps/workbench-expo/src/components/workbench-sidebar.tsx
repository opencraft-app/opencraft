import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import { BlurView } from "expo-blur";
import {
  PanelLeftClose,
  Plus,
  SquarePen,
} from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import { IconButton } from "./ui/button";
import { InteractiveSurface } from "./ui/interactive-surface";

interface WorkbenchSidebarProps {
  threads: readonly WorkbenchThread[];
  activeThreadId: string;
  topInset: number;
  onSelectThread(id: string): void;
  onNewTask(): void;
  onClose(): void;
}

function ThreadActivity({ status }: { status: WorkbenchThread["status"] }) {
  return (
    <View
      accessibilityLabel={status === "running" ? "Running" : status === "review" ? "Ready for review" : undefined}
      style={[
        styles.activity,
        status === "running" && styles.activityRunning,
        status === "review" && styles.activityReview,
      ]}
    />
  );
}

export function WorkbenchSidebar({
  threads,
  activeThreadId,
  topInset,
  onSelectThread,
  onNewTask,
  onClose,
}: WorkbenchSidebarProps) {
  const { theme } = useWorkbenchTheme();
  const secondary = theme.color.icon.secondary;
  const metrics = theme.metrics;

  return (
    <BlurView intensity={72} tint="systemMaterialLight" style={[styles.sidebar, { paddingTop: topInset }]}> 
      <View style={styles.titleBar}>
        <Text style={styles.largeTitle}>OpenCraft</Text>
        <View style={styles.titleActions}>
          <IconButton accessibilityLabel="New task" onPress={onNewTask} size="lg">
            <SquarePen color={theme.color.accent.blue} size={metrics.control.icon} strokeWidth={1.9} />
          </IconButton>
          <IconButton accessibilityLabel="Hide sidebar" onPress={onClose} size="lg">
            <PanelLeftClose color={secondary} size={metrics.control.icon} strokeWidth={1.9} />
          </IconButton>
        </View>
      </View>

      <View style={styles.taskSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>RECENT TASKS</Text>
          <IconButton accessibilityLabel="New task" onPress={onNewTask} size="lg">
            <Plus color={secondary} size={metrics.control.iconSmall} strokeWidth={2} />
          </IconButton>
        </View>

        <ScrollView contentContainerStyle={styles.threadList} showsVerticalScrollIndicator={false}>
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            return (
              <InteractiveSurface
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={thread.id}
                onPress={() => onSelectThread(thread.id)}
                style={[styles.thread, active && styles.threadActive]}
              >
                <ThreadActivity status={thread.status} />
                <View style={styles.threadCopy}>
                  <Text numberOfLines={1} style={styles.threadTitle}>{thread.title}</Text>
                  <Text numberOfLines={1} style={styles.threadMeta}>{thread.project} · {thread.time}</Text>
                </View>
                {thread.unread ? <View style={styles.unread} /> : null}
              </InteractiveSurface>
            );
          })}
        </ScrollView>
      </View>

    </BlurView>
  );
}

const styles = StyleSheet.create((theme) => ({
  sidebar: {
    width: theme.metrics.sidebar.width,
    flex: 1,
    paddingHorizontal: theme.metrics.sidebar.horizontalInset,
    backgroundColor: theme.material.sidebar,
  },
  titleBar: {
    height: theme.metrics.sidebar.largeTitleHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[1],
  },
  largeTitle: { color: theme.color.text.primary, ...theme.platformTypography.largeTitle },
  titleActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  taskSection: { flex: 1, minHeight: 0, paddingTop: theme.spacing[5] },
  sectionHeader: {
    height: theme.metrics.sidebar.sectionHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
  },
  sectionTitle: { color: theme.color.text.tertiary, ...theme.platformTypography.section },
  threadList: { gap: theme.spacing[1], paddingBottom: theme.spacing[4] },
  thread: {
    minHeight: theme.metrics.sidebar.threadHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.metrics.sidebar.selectionRadius,
  },
  threadActive: { backgroundColor: theme.material.selected },
  activity: {
    width: theme.metrics.control.activityDot,
    height: theme.metrics.control.activityDot,
    borderRadius: theme.radii.full,
    backgroundColor: "transparent",
  },
  activityRunning: { backgroundColor: theme.color.accent.positive },
  activityReview: { backgroundColor: theme.color.accent.blue },
  threadCopy: { flex: 1, minWidth: 0 },
  threadTitle: { color: theme.color.text.primary, ...theme.platformTypography.sidebarThread },
  threadMeta: { marginTop: 1, color: theme.color.text.tertiary, ...theme.platformTypography.sidebarMeta },
  unread: {
    width: theme.metrics.control.activityDot,
    height: theme.metrics.control.activityDot,
    borderRadius: theme.radii.full,
    backgroundColor: theme.color.accent.blue,
  },
}));
