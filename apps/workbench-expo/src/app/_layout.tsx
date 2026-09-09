import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Suspense, useEffect, useMemo } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  createExpoWorkbenchApplication,
  WorkbenchRuntimeProvider,
} from "../runtime/runtime-context";
import {
  createExpoPresentationRuntime,
  ExpoPresentationRuntimeProvider,
} from "../runtime/presentation-runtime";
import { LightVelaHermesTransport } from "@opencraft/plugin-lightvela-hermes/transport";
import { LightVelaAccountGate } from "../components/lightvela-account-gate";
import { createMobileLightVelaAccount, type MobileLightVelaAccount } from "../runtime/lightvela-account";

// The application graph exists before the React root. React presents external
// stores; it does not create or own Host/Thread/Replica lifetimes.
const account = createMobileLightVelaAccount();
const presentationRuntime = createExpoPresentationRuntime();

function ConnectedWorkbench({ account }: { readonly account: MobileLightVelaAccount }) {
  const application = useMemo(() => createExpoWorkbenchApplication({
    hostId: "velahermes0",
    hostLabel: "LightVela",
    transport: new LightVelaHermesTransport({ account }),
    transportEndpoint: null,
  }), [account]);
  useEffect(() => () => { void application.dispose(); }, [application]);
  return (
    <WorkbenchRuntimeProvider application={application}>
      <StatusBar style="dark" />
      <Slot />
    </WorkbenchRuntimeProvider>
  );
}

export default function RootLayout() {
  useEffect(() => () => {
    account.dispose();
    void presentationRuntime.then((runtime) => runtime.dispose());
  }, []);
  return (
    <SafeAreaProvider>
      <Suspense fallback={null}>
        <ExpoPresentationRuntimeProvider runtime={presentationRuntime}>
          <LightVelaAccountGate account={account}>
            <ConnectedWorkbench account={account} />
          </LightVelaAccountGate>
        </ExpoPresentationRuntimeProvider>
      </Suspense>
    </SafeAreaProvider>
  );
}
