import { StyleSheet } from "react-native-unistyles";

import { breakpoints, velaDark, velaLight } from "./tokens";

const appThemes = {
  light: velaLight,
  dark: velaDark,
};

type AppBreakpoints = typeof breakpoints;
type AppThemes = typeof appThemes;

declare module "react-native-unistyles" {
  export interface UnistylesBreakpoints extends AppBreakpoints {}

  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  breakpoints,
  settings: process.env.NODE_ENV === "test"
    ? {initialTheme: "light" as const}
    : {adaptiveThemes: true as const},
  themes: appThemes,
});
