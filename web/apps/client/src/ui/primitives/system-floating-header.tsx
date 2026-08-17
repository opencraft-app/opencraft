import type {ReactNode} from "react";
import {View, type StyleProp, type ViewStyle} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemMaterialSurface} from "./system-material-surface";

export type SystemFloatingHeaderLayoutMode = "compact" | "medium" | "wide";

export interface SystemFloatingHeaderProps {
  children: ReactNode;
  layoutMode: SystemFloatingHeaderLayoutMode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The only shared material and geometry owner for a primary content header. */
export function SystemFloatingHeader({
  children,
  layoutMode,
  style,
  testID = "system-floating-header",
}: SystemFloatingHeaderProps) {
  const compact = layoutMode === "compact";
  return (
    <View
      style={[
        styles.slot,
        compact ? styles.slotCompact : styles.slotWide,
        style,
      ]}
      testID={`${testID}-slot`}
    >
      <SystemMaterialSurface
        materialRole="floatingHeader"
        style={[
          styles.surface,
          compact ? styles.surfaceCompact : styles.surfaceWide,
        ]}
        testID={testID}
      >
        {children}
      </SystemMaterialSurface>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    position: "relative",
    width: "100%",
    zIndex: theme.semantic.layer.docked,
  },
  slotCompact: {
    paddingBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  slotWide: {
    paddingBottom: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  surface: {
    justifyContent: "center",
    minHeight: theme.recipes.desktopWorkspace.headerHeight,
    position: "relative",
    shadowColor: theme.shadows.floatingControl.color,
    shadowOffset: {height: theme.shadows.floatingControl.offsetY, width: 0},
    shadowOpacity: theme.shadows.floatingControl.opacity,
    shadowRadius: theme.shadows.floatingControl.radius,
  },
  surfaceCompact: {
    paddingHorizontal: theme.spacing.md,
  },
  surfaceWide: {
    paddingHorizontal: theme.spacing.xl,
  },
}));
