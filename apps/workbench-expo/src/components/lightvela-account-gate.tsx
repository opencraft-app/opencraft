import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";
import { Button } from "./ui/button";

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
      <Button
        disabled={busy}
        loading={busy}
        onPress={() => { void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined); }}
        size="lg"
        style={styles.signInButton}
      >
        {snapshot.phase === "error" ? "Try again" : "Sign in with LightVela"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    backgroundColor: theme.material.content,
  },
  mark: {
    width: 64,
    height: 64,
    borderRadius: theme.radii.xxl,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.button.primary,
  },
  markText: { color: theme.color.button.primaryForeground, fontSize: 30, fontWeight: "700" },
  title: { marginTop: theme.spacing[6], color: theme.color.text.primary, fontSize: 32, fontWeight: "700" },
  subtitle: {
    marginTop: theme.spacing[3],
    maxWidth: 360,
    color: theme.color.text.secondary,
    textAlign: "center",
    ...theme.platformTypography.body,
  },
  error: {
    marginTop: theme.spacing[5],
    maxWidth: 360,
    color: theme.color.accent.negative,
    textAlign: "center",
    ...theme.platformTypography.label,
  },
  signInButton: {
    marginTop: theme.spacing[6],
    minWidth: 240,
  },
}));
