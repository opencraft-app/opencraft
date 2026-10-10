import {View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import type {ComposerSurfaceLayoutProps} from "./composer-surface.types";

export function ComposerSurfaceLayout({
  attachments,
  editor,
  error,
  footer,
  quote,
}: ComposerSurfaceLayoutProps) {
  return (
    <View style={styles.layout} testID="composer-surface-layout">
      {quote}
      {attachments}
      <View style={styles.editor}>{editor}</View>
      {error}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    minHeight: 0,
    width: "100%",
  },
  layout: {
    minHeight: 0,
    width: "100%",
  },
});
