import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { StyleSheet as NativeStyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from "react-native";

type NativeTheme = typeof nativeThemes.light;
type NamedStyles = Record<string, ViewStyle | TextStyle | ImageStyle>;

export const StyleSheet = {
  hairlineWidth: NativeStyleSheet.hairlineWidth,
  create<T extends NamedStyles>(resolve: (theme: NativeTheme) => T): T {
    return NativeStyleSheet.create(resolve(nativeThemes.light)) as T;
  },
};
