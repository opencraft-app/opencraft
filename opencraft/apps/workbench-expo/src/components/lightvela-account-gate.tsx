import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import * as Linking from "expo-linking";
import { AppState, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { projectLightVelaBotOnboarding } from "@opencraft/plugin-lightvela-hermes/onboarding";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";
import { Button } from "./ui/button";

export function LightVelaAccountGate({ account, children }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode }) {
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
  useEffect(() => { void account.initialize().catch(() => undefined); }, [account]);
  const onboarding = projectLightVelaBotOnboarding({
    region: snapshot.region,
    phase: snapshot.phase,
    botCount: snapshot.botCount,
    error: snapshot.error,
  });
  useEffect(() => {
    if (onboarding.kind !== "bot-required") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void account.retry().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [account, onboarding.kind]);
  if (onboarding.kind === "ready") return children;
  const busy = onboarding.kind === "loading";
  const botRequired = onboarding.kind === "bot-required";
  const error = onboarding.kind === "error" || onboarding.kind === "sign-in-required"
    ? onboarding.error
    : null;
  return (
    <View style={styles.root}>
      <View style={styles.mark}><Text style={styles.markText}>V</Text></View>
      <Text style={styles.title}>OpenCraft</Text>
      <Text style={styles.subtitle}>
        {botRequired
          ? "Create your cloud AI companion to get started."
          : "Connect to your LightVela Bot to continue."}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button
        disabled={busy}
        loading={busy}
        onPress={() => {
          if (onboarding.kind === "bot-required") {
            void Linking.openURL(onboarding.createUrl).catch(() => undefined);
            return;
          }
          void (onboarding.kind === "error" ? account.retry() : account.signIn()).catch(() => undefined);
        }}
        size="lg"
        style={styles.signInButton}
      >
        {botRequired ? "Create Bot" : onboarding.kind === "error" ? "Try again" : "Sign in with LightVela"}
      </Button>
      {botRequired ? (
        <Button
          onPress={() => { void account.retry().catch(() => undefined); }}
          size="md"
          style={styles.refreshButton}
          variant="ghost"
        >
          I’ve created one
        </Button>
      ) : null}
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
  refreshButton: {
    marginTop: theme.spacing[2],
    minWidth: 240,
  },
}));
