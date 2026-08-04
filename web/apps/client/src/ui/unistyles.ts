import { StyleSheet } from "react-native-unistyles";

import { breakpoints, raftTheme } from "./tokens";

const appThemes = {
  raft: raftTheme,
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
    initialTheme: "raft",
  },
  themes: appThemes,
});
