import { StyleSheet } from "react-native-unistyles";

import { breakpoints, velaTheme } from "./tokens";

const appThemes = {
  vela: velaTheme,
};

type AppBreakpoints = typeof breakpoints;
type AppThemes = typeof appThemes;

declare module "react-native-unistyles" {
  export interface UnistylesBreakpoints extends AppBreakpoints {}

  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  breakpoints,
  settings: {
    initialTheme: "vela",
  },
  themes: appThemes,
});
