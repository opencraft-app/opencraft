import type {ViewStyle} from "react-native";
import {View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import type {ComposerFooterProps} from "./composer-surface.types";

export function ComposerFooterLayout({
  containerStyle,
  expandingControls,
  leadingActions,
  primaryAction,
  surfaceMode,
}: ComposerFooterProps & {containerStyle?: ViewStyle}) {
  const {theme} = useUnistyles();
  const metrics =
    theme.recipes.conversationWorkspace.composerSurfaceMetrics[surfaceMode];

  return (
    <View
      style={[
        styles.footer,
        {
          minHeight:
            theme.recipes.conversationWorkspace.composerToolbarMinHeight +
            metrics.footerInset,
          paddingBottom: metrics.footerInset,
        },
        containerStyle,
      ]}
      testID="composer-footer"
    >
      <View style={styles.leading}>{leadingActions}</View>
      <View style={styles.expanding}>{expandingControls}</View>
      <View style={styles.primary}>{primaryAction}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  expanding: {
    flex: 1,
    minWidth: 0,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  leading: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  primary: {
    alignItems: "center",
    flexShrink: 0,
    justifyContent: "center",
  },
}));
