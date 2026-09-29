import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AppState, ActivityIndicator, Text, View } from "react-native";
import { Button } from "heroui-native";
import type { MobileLightVelaAccount } from "../runtime/lightvela-account";

export function LightVelaAccountGate({ account, children }: { readonly account: MobileLightVelaAccount; readonly children: ReactNode; readonly allowWithoutBot?: boolean }) {
  const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
  useEffect(() => { void account.initialize().catch(() => undefined); }, [account]);
  useEffect(() => {
    if (snapshot.phase !== "authenticated") return;
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void account.retry().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [account, snapshot.phase]);
  if (snapshot.phase === "authenticated") return children;
  const busy = snapshot.phase === "loading";
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <View className="h-16 w-16 items-center justify-center rounded-3xl bg-primary"><Text className="text-3xl font-bold text-primary-foreground">V</Text></View>
      <Text className="mt-6 text-3xl font-bold text-foreground">OpenCraft</Text>
      <Text className="mt-3 max-w-80 text-center text-base text-muted">Sign in to open your LightVela workspace.</Text>
      {snapshot.error ? <Text className="mt-5 max-w-80 text-center text-danger">{snapshot.error}</Text> : null}
      <Button className="mt-6 min-w-60" size="lg" isDisabled={busy} onPress={() => { void (snapshot.phase === "error" ? account.retry() : account.signIn()).catch(() => undefined); }}>
        {busy ? <ActivityIndicator color="white" /> : snapshot.phase === "error" ? "Try again" : "Sign in with LightVela"}
      </Button>
    </View>
  );
}
