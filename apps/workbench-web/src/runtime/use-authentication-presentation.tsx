import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { AuthenticationFlowPort } from "@opencraft/workbench-runtime";
import type { ModalRequest } from "../components/modal";
import type { ExtensionAccountProjection } from "./extension-workbench-projection";
import type { ShellSignIn } from "../components/shell-navigation/navigation-content";

/** Shared by active and hostless shells. The shell projects a flow; it never infers completion from account data. */
export function useAuthenticationPresentation(
  flows: AuthenticationFlowPort,
  account: ExtensionAccountProjection | null,
  locationKey: string,
): { open(): void; modal: ModalRequest | null; signIn: ShellSignIn | null } {
  const flow = useSyncExternalStore(flows.subscribe, flows.getSnapshot, flows.getSnapshot);
  const previousLocation = useRef(locationKey);
  useLayoutEffect(() => {
    if (previousLocation.current === locationKey) return;
    previousLocation.current = locationKey;
    const current = flows.getSnapshot();
    if (current) flows.abandon(current.id);
  }, [flows, locationKey]);
  const open = () => {
    const providerId = account?.provider.authenticationProviderId;
    if (!providerId || !account.provider.signInViewId) return;
    flows.open({ providerId, owner: "shell.account-entry", reason: "account-entry", presentation: "dialog" });
  };
  const modal: ModalRequest | null = flow?.presentation === "dialog"
    && account?.provider.authenticationProviderId === flow.providerId ? {
      id: `sign-in:${flow.id}`,
      label: "Sign in",
      appearance: "utility",
      size: "compact",
      dismissOnOutsidePress: false,
      content: account.renderSignIn(flow.id),
      onDismiss: () => flows.cancel(flow.id),
      returnFocus: () => [...document.querySelectorAll<HTMLButtonElement>('.shell-navigation__entrance[data-surface="account"]')]
        .find(button => button.getClientRects().length > 0) ?? null,
    } : null;
  const ownFlow = flow?.presentation === "menu" && flow.providerId === account?.provider.authenticationProviderId ? flow : null;
  const select = (optionId: string) => {
    const providerId = account?.provider.authenticationProviderId;
    if (!providerId || !account.provider.signInOptions?.some(option => option.id === optionId)) return;
    const current = flows.getSnapshot();
    if (current) flows.cancel(current.id);
    const id = flows.open({ providerId, optionId, owner: "shell.account-entry", reason: "account-entry", presentation: "menu" });
    void flows.submit(id);
  };
  const signIn: ShellSignIn | null = account?.provider.signInOptions?.length ? {
    options: account.provider.signInOptions,
    pending: ownFlow?.phase === "pending",
    error: ownFlow?.error ?? null,
    select,
    cancel: () => { if (ownFlow) flows.cancel(ownFlow.id); },
    retry: () => { if (ownFlow?.optionId) select(ownFlow.optionId); },
  } : null;
  return { open, modal, signIn };
}
