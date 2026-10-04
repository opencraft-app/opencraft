import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import type {
  LightVelaMultiSessionOptions,
  LightVelaSessionActions,
  LightVelaSessionState,
} from "@/pages/marketing/agent-chat-panel";

interface EmbeddedWorkbenchConfig {
  readonly accountId?: string;
  readonly apiBase?: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly region: "cn" | "intl";
}

interface EmbeddedWorkbenchElement extends HTMLElement {
  configure(config: EmbeddedWorkbenchConfig): void;
  prepare(): Promise<void>;
  show(): Promise<void>;
  hide(): void;
  dispose(): Promise<void>;
  createConversation(): Promise<void>;
  selectConversation(conversationId: string): void;
  renameConversation(conversationId: string, title: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
}

function isEmbeddedWorkbenchElement(element: HTMLElement): element is EmbeddedWorkbenchElement {
  const candidate = element as Partial<EmbeddedWorkbenchElement>;
  return typeof candidate.configure === "function"
    && typeof candidate.prepare === "function"
    && typeof candidate.show === "function"
    && typeof candidate.hide === "function"
    && typeof candidate.dispose === "function"
    && typeof candidate.createConversation === "function";
}

interface AgentChatMigrationSurfaceProps extends EmbeddedWorkbenchConfig {
  readonly active: boolean;
  /** Explicit rollout authority. Route visibility alone must never adopt OpenCraft. */
  readonly enabled: boolean;
  readonly legacy: ReactNode;
  readonly multiSession: LightVelaMultiSessionOptions;
  readonly onOwnerChange?: (owner: "legacy" | "opencraft") => void;
  readonly onSessionCommandsChange?: (commands: EmbeddedSessionCommands | null) => void;
  readonly onSessionMutationStateChange?: (state: EmbeddedSessionMutationState | null) => void;
}

export interface EmbeddedSessionMutationState {
  readonly operation: "create" | "rename" | "delete";
  readonly chatId: string;
  readonly pending: boolean;
  readonly error: string | null;
}

export interface EmbeddedSessionCommands {
  createSession(): Promise<void>;
}

interface EmbeddedSessionsDetail {
  readonly sessions: LightVelaSessionState["sessions"];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedChatId: string | null;
}

const ELEMENT_NAME = "opencraft-embedded-workbench";
const scriptLoads = new Map<string, Promise<void>>();

function embeddedWorkbenchScriptUrl(): string | null {
  const configured = (
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL
      : undefined
  )?.trim();
  if (configured) return configured;
  if (typeof window !== "undefined" && (
    window.location.hostname === "127.0.0.1"
    || window.location.hostname === "localhost"
    || window.location.hostname === "localhost.lightvela.ai"
  )) {
    return "http://127.0.0.1:10000/__opencraft/embedded-workbench.js";
  }
  return null;
}

function loadEmbeddedWorkbench(url: string): Promise<void> {
  const existing = scriptLoads.get(url);
  if (existing) return existing;
  const operation = new Promise<void>((resolve, reject) => {
    if (customElements.get(ELEMENT_NAME)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.crossOrigin = "anonymous";
    script.dataset.opencraftEmbeddedWorkbench = "true";
    script.addEventListener("load", () => {
      void customElements.whenDefined(ELEMENT_NAME).then(() => resolve(), reject);
    }, { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error(`Could not load OpenCraft Embedded Workbench from ${url}`));
    }, { once: true });
    document.head.append(script);
  });
  scriptLoads.set(url, operation);
  operation.catch(() => scriptLoads.delete(url));
  return operation;
}

/** Resource preparation only: the confirmed Bot/Profile still owns Application creation. */
export function useEmbeddedWorkbenchResourcePreparation(enabled: boolean, active: boolean): void {
  useEffect(() => {
    if (!enabled || !active) return;
    const url = embeddedWorkbenchScriptUrl();
    if (url) void loadEmbeddedWorkbench(url).catch(() => {
      // The actual migration surface owns error UI and retries a failed load.
    });
  }, [enabled, active]);
}

export function AgentChatMigrationSurface({
  active,
  accountId,
  apiBase,
  enabled,
  instanceId,
  legacy,
  multiSession,
  onOwnerChange,
  onSessionCommandsChange,
  onSessionMutationStateChange,
  profileId,
  region,
}: AgentChatMigrationSurfaceProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const legacyRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<EmbeddedWorkbenchElement | null>(null);
  const multiSessionRef = useRef(multiSession);
  multiSessionRef.current = multiSession;
  const onOwnerChangeRef = useRef(onOwnerChange);
  onOwnerChangeRef.current = onOwnerChange;
  const onSessionCommandsChangeRef = useRef(onSessionCommandsChange);
  onSessionCommandsChangeRef.current = onSessionCommandsChange;
  const onSessionMutationStateChangeRef = useRef(onSessionMutationStateChange);
  onSessionMutationStateChangeRef.current = onSessionMutationStateChange;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [owner, setOwner] = useState<"legacy" | "opencraft">("legacy");
  const [started, setStarted] = useState(active && enabled);
  const presentedOwner = enabled ? owner : "legacy";

  useEffect(() => {
    if (!enabled) {
      setStarted(false);
      return;
    }
    if (active) setStarted(true);
  }, [active, enabled]);

  useEffect(() => {
    if (!started) return;
    const mount = mountRef.current;
    const scriptUrl = embeddedWorkbenchScriptUrl();
    if (mount === null || scriptUrl === null) return;
    let retired = false;
    let adopted = false;
    let element: EmbeddedWorkbenchElement | null = null;
    let latestSessions: EmbeddedSessionsDetail | null = null;
    const publishSessions = () => {
      if (!adopted || latestSessions === null) return;
      multiSessionRef.current.onSessionStateChange({
        sessions: latestSessions.sessions,
        loading: latestSessions.loading,
        historyLoading: false,
      });
      if (latestSessions.selectedChatId !== null) {
        multiSessionRef.current.onSelectedChatIdChange(latestSessions.selectedChatId);
      }
    };
    const sessionCommands: EmbeddedSessionCommands = {
      async createSession() {
        onSessionMutationStateChangeRef.current?.({
          operation: "create", chatId: "", pending: true, error: null,
        });
        try {
          await element!.createConversation();
          onSessionMutationStateChangeRef.current?.(null);
        } catch (cause) {
          onSessionMutationStateChangeRef.current?.({
            operation: "create",
            chatId: "",
            pending: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          throw cause;
        }
      },
    };
    const sessionActions: LightVelaSessionActions = {
      renameSession: (chatId, title) => {
        onSessionMutationStateChangeRef.current?.({
          operation: "rename", chatId, pending: true, error: null,
        });
        void element!.renameConversation(chatId, title).then(() => {
          onSessionMutationStateChangeRef.current?.(null);
        }).catch((cause: unknown) => {
          onSessionMutationStateChangeRef.current?.({
            operation: "rename",
            chatId,
            pending: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
      },
      deleteSession: (chatId) => {
        onSessionMutationStateChangeRef.current?.({
          operation: "delete", chatId, pending: true, error: null,
        });
        void element!.deleteConversation(chatId).then(() => {
          onSessionMutationStateChangeRef.current?.(null);
        }).catch((cause: unknown) => {
          onSessionMutationStateChangeRef.current?.({
            operation: "delete",
            chatId,
            pending: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
      },
    };
    const handleSessions = (event: Event) => {
      latestSessions = (event as CustomEvent<EmbeddedSessionsDetail>).detail;
      publishSessions();
    };
    const fallBackToLegacy = () => {
      if (element !== null && isEmbeddedWorkbenchElement(element)) element.hide();
      onSessionMutationStateChangeRef.current?.(null);
      if (adopted) multiSessionRef.current.onSessionActionsChange?.(null);
      onSessionCommandsChangeRef.current?.(null);
      adopted = false;
      onOwnerChangeRef.current?.("legacy");
      setOwner("legacy");
    };
    const handleEmbeddedError = () => fallBackToLegacy();

    void loadEmbeddedWorkbench(scriptUrl).then(async () => {
      if (retired) return;
      const candidate = document.createElement(ELEMENT_NAME);
      if (!isEmbeddedWorkbenchElement(candidate)) {
        throw new Error("OpenCraft Embedded Workbench did not register its element API");
      }
      element = candidate;
      elementRef.current = element;
      element.className = "block size-full";
      element.addEventListener("opencraft-sessions", handleSessions);
      element.addEventListener("opencraft-error", handleEmbeddedError);
      element.configure({ accountId, apiBase, instanceId, profileId, region });
      mount.append(element);
      await element.prepare();
      if (retired) return;
      if (activeRef.current) await element.show();
      else element.hide();
      if (!retired) {
        adopted = true;
        onOwnerChangeRef.current?.("opencraft");
        multiSessionRef.current.onSessionActionsChange?.(sessionActions);
        onSessionCommandsChangeRef.current?.(sessionCommands);
        publishSessions();
        setOwner("opencraft");
      }
    }).catch((error: unknown) => {
      if (retired) return;
      console.warn("[opencraft-embed] Falling back to AgentChat", error);
      fallBackToLegacy();
    });

    return () => {
      retired = true;
      setOwner("legacy");
      onOwnerChangeRef.current?.("legacy");
      if (adopted) multiSessionRef.current.onSessionActionsChange?.(null);
      onSessionCommandsChangeRef.current?.(null);
      onSessionMutationStateChangeRef.current?.(null);
      const current = element;
      element = null;
      elementRef.current = null;
      if (current !== null) {
        current.removeEventListener("opencraft-sessions", handleSessions);
        current.removeEventListener("opencraft-error", handleEmbeddedError);
        current.hide();
        void current.dispose().catch(() => undefined);
        current.remove();
      }
    };
  }, [accountId, apiBase, instanceId, profileId, region, started]);

  useEffect(() => {
    if (!enabled || owner !== "opencraft" || !multiSession.selectedChatId) return;
    const element = elementRef.current;
    if (element === null) return;
    try {
      element.selectConversation(multiSession.selectedChatId);
    } catch {
      // Session list delivery is authoritative; ignore a stale host selection.
    }
  }, [enabled, multiSession.selectedChatId, owner]);

  useEffect(() => {
    const element = elementRef.current;
    if (element === null || owner !== "opencraft") return;
    if (active && enabled) void element.show().catch(() => undefined);
    else element.hide();
  }, [active, enabled, owner]);

  return (
    <div
      aria-hidden={!active || undefined}
      className={cn(
        "h-[clamp(516px,calc(100vh-220px),960px)] min-h-0 overflow-hidden rounded-lg border border-black/[0.08] bg-white lg:h-full",
        active ? "relative" : "invisible pointer-events-none absolute inset-0",
      )}
      inert={active ? undefined : true}
    >
      <div
        ref={legacyRef}
        aria-hidden={!active || presentedOwner === "opencraft" || undefined}
        className={cn(
          "absolute inset-0 min-h-0 overflow-hidden",
          (!active || presentedOwner === "opencraft") && "invisible pointer-events-none",
        )}
        inert={!active || presentedOwner === "opencraft" ? true : undefined}
      >
        {presentedOwner === "legacy" ? legacy : null}
      </div>
      <div
        ref={mountRef}
        aria-hidden={!active || presentedOwner !== "opencraft" || undefined}
        className={cn(
          "absolute inset-0 min-h-0 overflow-hidden",
          (!active || presentedOwner !== "opencraft") && "invisible pointer-events-none",
        )}
        inert={!active || presentedOwner !== "opencraft" ? true : undefined}
      />
    </div>
  );
}
