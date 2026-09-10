import { Slot } from "expo-router";
import * as Crypto from "expo-crypto";
import { StatusBar } from "expo-status-bar";
import { Suspense } from "react";
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
let connectedApplication: ReturnType<typeof createExpoWorkbenchApplication> | null = null;

function getConnectedApplication(account: MobileLightVelaAccount) {
  connectedApplication ??= createExpoWorkbenchApplication({
    hostId: "velahermes0",
    hostLabel: account.getSnapshot().botName ?? "LightVela",
    transport: new LightVelaHermesTransport({
      account,
      bufferHttpResponses: true,
      sha1: async data => {
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data);
        return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA1, bytes));
      },
    }),
    transportEndpoint: null,
  });
  return connectedApplication;
}

function ConnectedWorkbench({ account }: { readonly account: MobileLightVelaAccount }) {
  const application = getConnectedApplication(account);
  return (
    <WorkbenchRuntimeProvider application={application}>
      <StatusBar style="dark" />
      <Slot />
    </WorkbenchRuntimeProvider>
  );
}

export default function RootLayout() {
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
