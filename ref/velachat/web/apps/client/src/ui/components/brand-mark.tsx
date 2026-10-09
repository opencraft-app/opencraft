import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <View
      accessibilityLabel="Agent Network"
      style={[styles.mark, compact && styles.markCompact]}
      testID="agent-network-mark"
    >
      {compact ? null : <View style={styles.highlight} />}
      <Text style={[styles.wordmark, compact && styles.wordmarkCompact]}>
        AN
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  highlight: {
    backgroundColor: theme.semantic.color.brandHighlight,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.brandHighlightSize,
    position: "absolute",
    right: theme.recipes.identity.brandHighlightOffsetX,
    top: theme.recipes.identity.brandHighlightOffsetY,
    width: theme.recipes.identity.brandHighlightSize,
  },
  mark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.brandAccent,
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.identity.brandMarkSize,
    justifyContent: "center",
    overflow: "hidden",
    width: theme.recipes.identity.brandMarkSize,
  },
  markCompact: {
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.identity.brandMarkCompactSize,
    width: theme.recipes.identity.brandMarkCompactSize,
  },
  wordmark: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.brandMark,
  },
  wordmarkCompact: {
    ...theme.semantic.typography.brandMarkCompact,
  },
}));
