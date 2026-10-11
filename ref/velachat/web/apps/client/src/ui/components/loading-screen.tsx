import { ActivityIndicator, Text, View } from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";
import { BrandMark } from "./brand-mark";

export function LoadingScreen() {
  const {theme} = useUnistyles();
  return (
    <View style={styles.loading}>
      <BrandMark />
      <ActivityIndicator
        color={theme.semantic.color.iconAccent}
        size="small"
      />
      <Text style={styles.label}>正在连接 VELA</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  loading: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
    gap: theme.spacing.md,
    justifyContent: "center",
  },
}));
