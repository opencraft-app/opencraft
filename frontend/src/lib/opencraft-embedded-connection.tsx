import React, { createContext, useContext, useEffect, type ReactNode } from "react";
import { useOpenClaw } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useAppSearchParams } from "@/lib/app-navigation";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { isGlobal } from "@/lib/region";
import { AUTH_SESSION_CHANGED_EVENT, readStoredAuthToken } from "@/repositories/http-repositories";
import type { BotTerminalSession } from "@/domain/types";
import { EMBEDDED_WORKBENCH_ELEMENT_NAME, embeddedWorkbenchScriptUrl, loadEmbeddedWorkbench,
  useEmbeddedWorkbenchResourcePreparation } from "./opencraft-embedded-resources";

/** Opaque capability; only the Embedded module can claim its physical resources. */
export interface EmbeddedPhysicalConnectionPreparation { dispose(): void }
interface PreparationConstructor {
  preparePhysicalConnection(options: {
    accountId: string;
    instanceId: string;
    region: "cn" | "intl";
    apiBase: string;
    assertAuthority(): void;
    createSession(signal: AbortSignal): Promise<BotTerminalSession>;
  }): EmbeddedPhysicalConnectionPreparation;
}
const PreparationContext = createContext<EmbeddedPhysicalConnectionPreparation | null>(null);
export const useEmbeddedPhysicalConnectionPreparation = () => useContext(PreparationContext);

/** Lives inside the auth gate but outside the Profile/content gate. */
export function EmbeddedChatPreparation({ active, children }: { active: boolean; children: ReactNode }) {
  useEmbeddedWorkbenchResourcePreparation(!isGlobal, active);
  const { instanceDiscovery } = useOpenClaw();
  const { session } = useSession();
  const repositories = useRepositories();
  const [params] = useAppSearchParams();
  const requestedBotId = params.get("bot")?.trim() ?? "";
  const accountId = session?.user?.id;
  const apiBase = resolveConfiguredAuthApiBaseUrl();
  const running = instanceDiscovery?.items.filter(instance => instance.running) ?? [];
  // A named Profile cannot reveal its physical instance. Never guess the first
  // of several machines or open a speculative connection to every machine.
  const instanceId = instanceDiscovery?.items.length === 1 && running.length === 1 ? running[0]?.instanceId
    : running.find(instance => instance.instanceId === requestedBotId)?.instanceId;
  const [preparation, setPreparation] = React.useState<EmbeddedPhysicalConnectionPreparation | null>(null);

  useEffect(() => {
    setPreparation(null);
    const scriptUrl = embeddedWorkbenchScriptUrl();
    if (!active || isGlobal || !apiBase || !scriptUrl || !instanceId || !accountId
      || instanceDiscovery?.accountId !== accountId || !instanceDiscovery.isCurrent()) return;
    let retired = false;
    let owned: EmbeddedPhysicalConnectionPreparation | null = null;
    const token = readStoredAuthToken();
    if (!token) return;
    const assertAuthority = () => {
      if (retired || readStoredAuthToken() !== token || !instanceDiscovery.isCurrent()) {
        throw new DOMException("Embedded preparation authority retired", "AbortError");
      }
    };
    const retire = () => {
      retired = true;
      owned?.dispose();
    };
    const sessionChanged = () => {
      if (readStoredAuthToken() === token) return;
      retire();
      setPreparation(null);
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, sessionChanged);
    window.addEventListener("storage", sessionChanged);
    void loadEmbeddedWorkbench(scriptUrl).then(() => {
      assertAuthority();
      const constructor = customElements.get(EMBEDDED_WORKBENCH_ELEMENT_NAME) as
        (CustomElementConstructor & Partial<PreparationConstructor>) | undefined;
      // Old independently deployed Embedded artifacts retain the ordinary path.
      if (typeof constructor?.preparePhysicalConnection !== "function") return;
      owned = constructor.preparePhysicalConnection({
        accountId, instanceId, region: "cn", apiBase, assertAuthority,
        createSession: async signal => {
          assertAuthority();
          const result = await repositories.bots.getTerminalSession(instanceId, {
            signal, suppressUnauthorizedBroadcast: true,
          });
          assertAuthority();
          return result;
        },
      });
      setPreparation(owned);
    }).catch(() => { retire(); });
    return () => {
      retire();
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, sessionChanged);
      window.removeEventListener("storage", sessionChanged);
    };
  }, [active, apiBase, accountId, instanceId, instanceDiscovery, repositories.bots]);

  return <PreparationContext value={preparation}>{children}</PreparationContext>;
}
