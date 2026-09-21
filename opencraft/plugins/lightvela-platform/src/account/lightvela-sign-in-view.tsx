import { useSyncExternalStore } from "react";
import { SettingsPanel, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { LightVelaAccountService } from "./lightvela-account-service";
import { LightVelaLoginOptions } from "../settings/lightvela-login-options";

/** Dedicated presentation; successful authentication can never morph this into Account. */
export function createLightVelaSignInView(account: LightVelaAccountService) {
  return function LightVelaSignInView({ host, authenticationFlowId }: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    return <SettingsPanel title="Sign in">
      <LightVelaLoginOptions account={account} snapshot={snapshot} authentication={host.authentication} flowId={authenticationFlowId} />
    </SettingsPanel>;
  };
}
