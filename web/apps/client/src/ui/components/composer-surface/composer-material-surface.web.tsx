import {useState} from "react";
import type {ViewProps} from "react-native";
import {View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import type {ComposerMaterialSurfaceProps} from "./composer-surface.types";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface SurfaceMouseEvent {
  button: number;
  defaultPrevented: boolean;
  target: {closest(selector: string): unknown};
}

export function shouldForwardComposerSurfacePress(
  event: SurfaceMouseEvent,
): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.target.closest(INTERACTIVE_SELECTOR)
  );
}

export function ComposerMaterialSurface({
  children,
  disabled = false,
  onPressBackground,
  surfaceMode,
  testID = "composer-material-surface",
}: ComposerMaterialSurfaceProps) {
  const {theme} = useUnistyles();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const metrics =
    theme.recipes.conversationWorkspace.composerSurfaceMetrics[surfaceMode];
  const webProps = {
    dataSet: {velaComposerSurface: surfaceMode},
    onBlurCapture: (event: {
      currentTarget: {contains(value: unknown): boolean};
      relatedTarget: unknown;
    }) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    },
    onFocusCapture: () => setFocused(true),
    onMouseDown: (event: SurfaceMouseEvent) => {
      if (shouldForwardComposerSurfacePress(event)) onPressBackground?.();
    },
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } as unknown as ViewProps;

  return (
    <View
      {...webProps}
      style={[
        styles.surface,
        {
          borderRadius: metrics.radius,
          minHeight: metrics.surfaceMinHeight,
        },
        hovered && styles.hovered,
        focused && styles.focused,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  disabled: {
    opacity: theme.semantic.opacity.contentMuted,
  },
  focused: {
    borderColor: theme.semantic.color.borderFocus,
    boxShadow: `0 0 0 2px ${theme.semantic.color.fieldFocusGlow}`,
  },
  hovered: {
    borderColor: theme.semantic.color.borderFieldHover,
  },
  surface: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.composerFill,
    borderColor: theme.semantic.color.borderOverlay,
    borderWidth: theme.semantic.stroke.hairline,
    boxSizing: "border-box",
    overflow: "hidden",
    position: "relative",
    shadowColor: theme.shadows.floatingControl.color,
    shadowOffset: {height: theme.shadows.floatingControl.offsetY, width: 0},
    shadowOpacity: theme.shadows.floatingControl.opacity,
    shadowRadius: theme.shadows.floatingControl.radius,
    width: "100%",
    WebkitBackdropFilter: theme.semantic.material.blur,
    ...theme.semantic.motion.transition.surface,
  },
}));
