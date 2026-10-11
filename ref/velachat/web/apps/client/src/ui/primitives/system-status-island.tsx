import type {ReactNode} from "react";
import {useState} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";
import ChevronDown from "lucide-react-native/icons/chevron-down";

import {SystemMaterialSurface} from "./system-material-surface";

export type SystemStatusIslandTone =
  | "danger"
  | "info"
  | "neutral"
  | "positive"
  | "warning";

export interface SystemStatusIslandProps {
  busy?: boolean;
  details?: ReactNode;
  summary: string;
  testID?: string;
  tone: SystemStatusIslandTone;
  topInset?: number;
}

export function SystemStatusIsland({
  busy = false,
  details,
  summary,
  testID = "system-status-island",
  tone,
  topInset,
}: SystemStatusIslandProps) {
  const {theme} = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(details);
  const summaryContent = (
    <>
      {busy ? (
        <ActivityIndicator
          color={statusColor(theme, tone)}
          size="small"
          testID={`${testID}-activity`}
        />
      ) : (
        <View
          style={[styles.glyph, toneStyle[tone]]}
          testID={`${testID}-glyph`}
        />
      )}
      <Text
        accessibilityLiveRegion="polite"
        numberOfLines={1}
        style={styles.summary}
        testID={`${testID}-summary`}
      >
        {summary}
      </Text>
      {expandable ? (
        <View style={[styles.disclosure, expanded && styles.disclosureExpanded]}>
          <ChevronDown
            color={theme.semantic.color.iconSecondary}
            size={theme.semantic.icon.size.compact}
            strokeWidth={theme.semantic.icon.stroke.regular}
          />
        </View>
      ) : null}
    </>
  );
  const handleKeyDown = (event: {key?: string}) => {
    if (event.key === "Escape" && expanded) setExpanded(false);
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, topInset === undefined ? null : {top: topInset}]}
      testID={testID}
    >
      <SystemMaterialSurface
        materialRole="floatingControl"
        style={[styles.surface, expanded && styles.surfaceExpanded]}
      >
        {expandable ? (
          <Pressable
            {...({onKeyDown: handleKeyDown} as object)}
            accessibilityLabel={summary}
            accessibilityRole="button"
            accessibilityState={{expanded}}
            aria-expanded={expanded}
            onPress={() => setExpanded(current => !current)}
            style={({pressed}) => [
              styles.trigger,
              pressed && styles.triggerPressed,
            ]}
          >
            {summaryContent}
          </Pressable>
        ) : (
          <View style={styles.trigger}>{summaryContent}</View>
        )}
        {expanded && details ? (
          <ScrollView
            contentContainerStyle={styles.detailsContent}
            keyboardShouldPersistTaps="handled"
            style={styles.details}
            testID={`${testID}-details`}
          >
            {details}
          </ScrollView>
        ) : null}
      </SystemMaterialSurface>
    </View>
  );
}

function statusColor(
  theme: ReturnType<typeof useUnistyles>["theme"],
  tone: SystemStatusIslandTone,
): string {
  return tone === "danger"
    ? theme.semantic.color.statusDanger
    : tone === "info"
      ? theme.semantic.color.statusInfo
      : tone === "positive"
        ? theme.semantic.color.statusPositive
        : tone === "warning"
          ? theme.semantic.color.statusWarning
          : theme.semantic.color.statusNeutral;
}

const styles = StyleSheet.create(theme => ({
  details: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    maxHeight: theme.recipes.overlay.searchPanelMaxHeight,
    width: "100%",
  },
  detailsContent: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  disclosure: {
    alignItems: "center",
    height: theme.semantic.icon.size.compact,
    justifyContent: "center",
    ...theme.semantic.motion.transition.control,
    width: theme.semantic.icon.size.compact,
  },
  disclosureExpanded: {
    transform: [{rotate: "180deg"}],
  },
  glyph: {
    backgroundColor: theme.semantic.color.statusNeutral,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  glyphDanger: {backgroundColor: theme.semantic.color.statusDanger},
  glyphInfo: {backgroundColor: theme.semantic.color.statusInfo},
  glyphPositive: {backgroundColor: theme.semantic.color.statusPositive},
  glyphWarning: {backgroundColor: theme.semantic.color.statusWarning},
  host: {
    alignItems: "center",
    left: theme.spacing.md,
    position: "absolute",
    right: theme.spacing.md,
    top: theme.spacing.md,
    zIndex: theme.semantic.layer.overlay,
  },
  summary: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    minWidth: 0,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  surface: {
    alignSelf: "center",
    maxWidth: theme.recipes.contentMeasure.compactMaxWidth,
    minHeight: theme.recipes.status.toastMinHeight,
    overflow: "hidden",
    shadowColor: theme.shadows.floatingControl.color,
    shadowOffset: {height: theme.shadows.floatingControl.offsetY, width: 0},
    shadowOpacity: theme.shadows.floatingControl.opacity,
    shadowRadius: theme.shadows.floatingControl.radius,
    width: "100%",
    ...theme.semantic.motion.transition.surface,
  },
  surfaceExpanded: {
    maxWidth: theme.recipes.contentMeasure.noticeMaxWidth,
    minHeight: theme.recipes.status.bannerMinHeight,
    shadowColor: theme.shadows.overlay.color,
    shadowOffset: {height: theme.shadows.overlay.offsetY, width: 0},
    shadowOpacity: theme.shadows.overlay.opacity,
    shadowRadius: theme.shadows.overlay.radius,
  },
  trigger: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.status.toastMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  triggerPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
}));

const toneStyle = {
  danger: styles.glyphDanger,
  info: styles.glyphInfo,
  neutral: null,
  positive: styles.glyphPositive,
  warning: styles.glyphWarning,
} satisfies Record<SystemStatusIslandTone, object | null>;
