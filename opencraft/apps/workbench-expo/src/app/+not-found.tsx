import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function NotFoundRoute() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#fff", padding: 24 }}>
      <Text style={{ color: "#111827", fontSize: 22, fontWeight: "600" }}>This OpenCraft route does not exist.</Text>
      <Link href="/" style={{ color: "#2563eb", fontSize: 16 }}>Return to OpenCraft</Link>
    </View>
  );
}
