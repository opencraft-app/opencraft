import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";

export function LightVelaAccountGate({ account, children }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode }) {
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
  useEffect(() => { void account.initialize().catch(() => undefined); }, [account]);
  if (snapshot.phase === "authenticated") return children;
  const busy = snapshot.phase === "loading";
  return (
    <View style={styles.root}>
      <View style={styles.mark}><Text style={styles.markText}>V</Text></View>
      <Text style={styles.title}>OpenCraft</Text>
      <Text style={styles.subtitle}>Connect to your LightVela Bot to continue.</Text>
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => { void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined); }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{snapshot.phase === "error" ? "Try again" : "Sign in with LightVela"}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, backgroundColor: "#fff" },
  mark: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "#111" },
  markText: { color: "#fff", fontSize: 30, fontWeight: "700" },
  title: { marginTop: 24, color: "#111", fontSize: 32, fontWeight: "700" },
  subtitle: { marginTop: 10, maxWidth: 360, color: "#747474", fontSize: 17, lineHeight: 24, textAlign: "center" },
  error: { marginTop: 18, maxWidth: 360, color: "#b42318", fontSize: 14, lineHeight: 20, textAlign: "center" },
  button: { marginTop: 28, minWidth: 240, minHeight: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, backgroundColor: "#111" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.76 },
  disabled: { opacity: 0.55 },
});
