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
  const overlay = materialRole === "dialog" ||
    materialRole === "popover" ||
    materialRole === "floatingControl" ||
    materialRole === "composer";
  const navigation = materialRole === "navigationChrome" ||
    materialRole === "compactNavigation";
  return (
    <View
      style={[
        styles.base,
        styles.content,
        navigation && styles.navigation,
        overlay && styles.overlay,
        materialRole === "toolbar" && styles.toolbar,
        !active && navigation && styles.inactiveNavigation,
        style,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {position: "relative"},
  content: {backgroundColor: theme.semantic.color.paneSurface},
  inactiveNavigation: {
    backgroundColor: theme.semantic.color.sidebarSurface,
  },
  navigation: {backgroundColor: theme.semantic.color.navigationSurface},
  overlay: {
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
  },
  toolbar: {backgroundColor: theme.semantic.color.surfaceTransparent},
}));
