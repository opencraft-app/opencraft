import { nativeThemes } from "@opencraft/design-system/tokens.native";

type ChatRenderNativeThemes = {
  light: typeof nativeThemes.light;
  dark: typeof nativeThemes.dark;
};

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends ChatRenderNativeThemes {}
}
