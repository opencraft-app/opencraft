import {View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import type {
  SystemMaterialSurfaceProps,
} from "./system-material-surface.types";

export function SystemMaterialSurface({
  children,
  materialRole,
  style,
  testID,
}: SystemMaterialSurfaceProps) {
  return (
    <View
      style={[
        styles.base,
        materialRole === "navigationChrome" && styles.navigationChrome,
        materialRole === "compactNavigation" && styles.compactNavigation,
        materialRole === "content" && styles.content,
        materialRole === "toolbar" && styles.toolbar,
        materialRole === "popover" && styles.popover,
        materialRole === "dialog" && styles.dialog,
        materialRole === "floatingControl" && styles.floatingControl,
        materialRole === "composer" && styles.composer,
        style,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {
    position: "relative",
  },
  compactNavigation: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.navigationFill,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  composer: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.composerFill,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  content: {
    backgroundColor: theme.semantic.color.paneSurface,
  },
  dialog: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.composerFill,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  floatingControl: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.composerFill,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  navigationChrome: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.navigationFill,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  popover: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.composerFill,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  toolbar: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
  },
}));
