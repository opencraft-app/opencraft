import { Link } from "expo-router";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export default function NotFoundRoute() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>This OpenCraft route does not exist.</Text>
      <Link href="/" style={styles.link}>Return to the workbench</Link>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3], backgroundColor: theme.color.surface.under },
  title: { color: theme.color.text.primary, ...theme.typography.modeTitle },
  link: { color: theme.color.accent.blue, ...theme.typography.body },
}));
