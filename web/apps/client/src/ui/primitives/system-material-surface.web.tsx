import {View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import type {
  SystemMaterialSurfaceProps,
} from "./system-material-surface.types";
import {useSystemWindowActive} from "../system-window-state";

export function SystemMaterialSurface({
  children,
  materialRole,
  style,
  testID,
}: SystemMaterialSurfaceProps) {
  const active = useSystemWindowActive();
  const navigation = materialRole === "navigationChrome" ||
    materialRole === "compactNavigation";
  return (
    <View
      {...({dataSet: {velaMaterial: materialRole}} as object)}
      style={[
        styles.base,
        materialRole === "navigationChrome" && styles.navigationChrome,
        materialRole === "compactNavigation" && styles.compactNavigation,
        materialRole === "content" && styles.content,
        materialRole === "toolbar" && styles.toolbar,
        materialRole === "popover" && styles.popover,
        materialRole === "dialog" && styles.dialog,
        materialRole === "floatingHeader" && styles.floatingHeader,
        materialRole === "floatingControl" && styles.floatingControl,
        materialRole === "composer" && styles.composer,
        !active && navigation && styles.inactiveNavigation,
        !active && materialRole === "floatingHeader" && styles.inactiveFloatingHeader,
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
  floatingHeader: {
    backdropFilter: theme.semantic.material.blur,
    backgroundColor: theme.semantic.material.floatingHeaderFill,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
    WebkitBackdropFilter: theme.semantic.material.blur,
  },
  inactiveFloatingHeader: {
    backgroundColor: theme.semantic.material.floatingHeaderInactiveFill,
  },
  inactiveNavigation: {
    backgroundColor: theme.semantic.material.navigationInactiveFill,
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
