import {Pressable} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import type {ComposerMaterialSurfaceProps} from "./composer-surface.types";

export function ComposerMaterialSurface({
  children,
  disabled = false,
  onPressBackground,
  surfaceMode,
  testID = "composer-material-surface",
}: ComposerMaterialSurfaceProps) {
  const {theme} = useUnistyles();
  const metrics =
    theme.recipes.conversationWorkspace.composerSurfaceMetrics[surfaceMode];

  return (
    <Pressable
      disabled={disabled}
      onPress={onPressBackground}
      style={[
        styles.surface,
        {
          borderRadius: metrics.radius,
          minHeight: metrics.surfaceMinHeight,
        },
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  disabled: {
    opacity: theme.semantic.opacity.contentMuted,
  },
  surface: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    overflow: "hidden",
    position: "relative",
    shadowColor: theme.shadows.floatingControl.color,
    shadowOffset: {height: theme.shadows.floatingControl.offsetY, width: 0},
    shadowOpacity: theme.shadows.floatingControl.opacity,
    shadowRadius: theme.shadows.floatingControl.radius,
    width: "100%",
  },
}));
