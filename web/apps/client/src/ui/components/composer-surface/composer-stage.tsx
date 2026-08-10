import {View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import type {ComposerStageProps} from "./composer-surface.types";

export function ComposerStage({children, overlay, surfaceMode}: ComposerStageProps) {
  return (
    <View
      style={[
        styles.stage,
        surfaceMode === "desktop" ? styles.desktop : styles.fullWidth,
      ]}
      testID="composer-stage"
    >
      {overlay}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  desktop: {
    maxWidth: theme.recipes.conversationWorkspace.composerDesktopMaxWidth,
  },
  fullWidth: {
    maxWidth: "100%",
  },
  stage: {
    alignSelf: "center",
    overflow: "visible",
    position: "relative",
    width: "100%",
    zIndex: theme.semantic.layer.popover,
  },
}));
