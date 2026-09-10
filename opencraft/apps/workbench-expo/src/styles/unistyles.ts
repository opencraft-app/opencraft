import { frame } from "@opencraft/design-system/tokens";
import { nativeThemes } from "@opencraft/design-system/tokens.native";
import { StyleSheet } from "react-native-unistyles";

const lightTheme = nativeThemes.light;
const darkTheme = nativeThemes.dark;

const breakpoints = {
  compact: 0,
  medium: frame.smallBreakpoint,
  wide: frame.tabletBreakpoint,
} as const;

type OpenCraftAppThemes = {
  light: typeof lightTheme;
  dark: typeof darkTheme;
};

type OpenCraftAppBreakpoints = typeof breakpoints;

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends OpenCraftAppThemes {}
  export interface UnistylesBreakpoints extends OpenCraftAppBreakpoints {}
}

StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
  },
  breakpoints,
  settings: {
    initialTheme: "light",
  },
});
