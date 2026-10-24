import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { StyleSheet as NativeStyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from "react-native";

const theme = nativeThemes.light;
type WorkbenchTheme = typeof theme;
type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>;

// The legacy Android workbench uses the same light design tokens with React
// Native styles. The iOS site shell uses HeroUI Native in its installed build.
export function useWorkbenchTheme() {
  return { theme };
}

export const StyleSheet = {
  hairlineWidth: NativeStyleSheet.hairlineWidth,
  create<T extends NamedStyles>(styles: T | ((value: WorkbenchTheme) => T)): T {
    return NativeStyleSheet.create(typeof styles === "function" ? styles(theme) : styles) as T;
  },
};
