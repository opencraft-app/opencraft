import { clearPendingWorkbenchPrompt, readPendingWorkbenchPrompt, withSharedTechStack } from "./workbench-prompt-templates";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useT } from "@/i18n/t";
import { ChatLoadingState } from "@/components/site/chat-loading-state";
import { isCN } from "@/lib/region";

import { AUTH_SESSION_CHANGED_EVENT, readStoredAuthToken } from "@/repositories/http-repositories";
import { cn } from "@/lib/utils";
import { useEmbeddedPhysicalConnectionPreparation } from "@/lib/opencraft-embedded-connection";
import {
  EMBEDDED_WORKBENCH_ELEMENT_NAME as ELEMENT_NAME,
  embeddedWorkbenchScriptUrl,
  loadEmbeddedWorkbench,
} from "@/lib/opencraft-embedded-resources";
import type {
  LightVelaMultiSessionOptions,
  LightVelaSessionActions,
  LightVelaSessionState,
} from "@/pages/marketing/agent-chat-panel";

interface EmbeddedWorkbenchConfig {
  /** In-process credential accessor; never serialize into an HTML attribute. */
  readonly getSessionToken?: () => string | null;
  readonly accountId?: string;
  readonly apiBase?: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly region: "cn" | "intl";
  readonly physicalConnection?: unknown;
}

interface EmbeddedWorkbenchElement extends HTMLElement {
  submitPrompt?(requestId: string, text: string): boolean;
  configure(config: EmbeddedWorkbenchConfig): void;
  prepare(): Promise<void>;
  reconnect?(): Promise<void>;
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

interface AgentChatMigrationSurfaceProps extends Omit<EmbeddedWorkbenchConfig, "getSessionToken"> {
  readonly active: boolean;
  readonly agentPaused?: boolean;
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
  readonly isDraft?: boolean;
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
  agentPaused = false,
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
  const t = useT();
  const physicalConnection = useEmbeddedPhysicalConnectionPreparation();
  const physicalConnectionRef = useRef(physicalConnection);
  physicalConnectionRef.current = physicalConnection;
  const [promptRevision, setPromptRevision] = useState(0);
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
  const [connection, setConnection] = useState<{ phase: string; failureCode: string | null }>({ phase: "connecting", failureCode: null });
  const [startupFailed, setStartupFailed] = useState(false);
  const [connectionSlow, setConnectionSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [owner, setOwner] = useState<"loading" | "legacy" | "opencraft">("loading");
  const [started, setStarted] = useState(active && enabled);
  const presentedOwner = enabled ? owner : "legacy";

  const unavailable = enabled && (agentPaused || owner !== "opencraft" || connection.phase !== "ready");
  useEffect(() => {
    setConnectionSlow(false);
    if (!unavailable || agentPaused) return;
    const timer = window.setTimeout(() => setConnectionSlow(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [agentPaused, unavailable, sessionRevision]);

  const retryConnection = async () => {
    const element = elementRef.current;
    if (agentPaused || retrying) return;
    if (startupFailed || element === null) {
      setSessionRevision(value => value + 1);
      return;
    }
    setRetrying(true);
    try { await element.reconnect?.(); }
    catch { /* Connection events own recoverable failure presentation. */ }
    finally { if (elementRef.current === element) setRetrying(false); }
  };

  useEffect(() => {
    if (!enabled) {
      setStarted(false);
      return;
    }
    if (active) setStarted(true);
  }, [active, enabled]);

  useEffect(() => {
    if (!started || !enabled) return;
    const mount = mountRef.current;
    const scriptUrl = embeddedWorkbenchScriptUrl();
    if (mount === null) return;
    setOwner("loading");
    setStartupFailed(false);
    setRetrying(false);
    setConnection({ phase: "connecting", failureCode: null });
    if (!profileId.trim()) {
      setConnection({ phase: "error", failureCode: "intervention:configuration-required" });
      return;
    }
    if (scriptUrl === null) {
      setStartupFailed(true);
      return;
    }
    let retired = false;
    let failed = false;
    let adopted = false;
    let element: EmbeddedWorkbenchElement | null = null;
    const initialToken = readStoredAuthToken();
    const getSessionToken = () => {
      if (retired || !initialToken || readStoredAuthToken() !== initialToken) {
        throw new Error("The console session changed; reconnect OpenCraft");
      }
      return initialToken;
    };
    const handleSessionChange = () => {
      if (readStoredAuthToken() === initialToken) return;
      retired = true;
      element?.hide();
      void element?.dispose().catch(() => undefined);
      setSessionRevision((revision) => revision + 1);
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChange);
    window.addEventListener("storage", handleSessionChange);
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
      if (retired) return;
      latestSessions = (event as CustomEvent<EmbeddedSessionsDetail>).detail;
      publishSessions();
      setPromptRevision(revision => revision + 1);
    };
    const handleConnection = (event: Event) => {
      if (retired) return;
      const detail = (event as CustomEvent<{ phase: string; failureCode: string | null }>).detail;
      setConnection(detail);
    };
    const handleEmbeddedError = () => {
      if (retired) return;
      // Recoverable transport errors arrive through opencraft-connection.
      // Keep an adopted canvas mounted even if a navigation/action fails.
      if (!adopted) { failed = true; setStartupFailed(true); }
    };

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
      element.addEventListener("opencraft-connection", handleConnection);
      element.configure({ accountId, apiBase, instanceId, profileId, region, getSessionToken,
        physicalConnection: physicalConnectionRef.current ?? undefined });
      mount.append(element);
      await candidate.prepare();
      if (retired || failed) return;
      if (activeRef.current) await candidate.show();
      else candidate.hide();
      if (!retired && !failed) {
        adopted = true;
        onOwnerChangeRef.current?.("opencraft");
        multiSessionRef.current.onSessionActionsChange?.(sessionActions);
        onSessionCommandsChangeRef.current?.(sessionCommands);
        publishSessions();
        setOwner("opencraft");
        setConnection(current => current.phase === "connecting" ? { phase: "ready", failureCode: null } : current);
      }
    }).catch((cause: unknown) => {
      if (retired) return;
      console.warn("[opencraft-embed] startup failed", { stage: element === null ? "module" : "application", error: cause });
      failed = true;
      setStartupFailed(true);
    });

    return () => {
      retired = true;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChange);
      window.removeEventListener("storage", handleSessionChange);
      setOwner("loading");
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
        current.removeEventListener("opencraft-connection", handleConnection);
        current.hide();
        void current.dispose().catch(() => undefined);
        current.remove();
      }
    };
  }, [accountId, apiBase, enabled, instanceId, profileId, region, sessionRevision, started]);

  useEffect(() => {
    if (!active || !enabled || owner !== "opencraft" || connection.phase !== "ready") return;
    const element = elementRef.current;
    const pending = readPendingWorkbenchPrompt();
    if (!pending || !element?.submitPrompt) return;
    try {
      const requestId = `${pending.templateId}:${pending.createdAt}`;
      if (element.submitPrompt(requestId, withSharedTechStack(pending.prompt))) clearPendingWorkbenchPrompt(pending);
    } catch {
      // Not admitted: retain storage and the Composer text for explicit retry.
    }
  }, [active, enabled, owner, connection.phase, promptRevision]);

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

  const connectionMessage = agentPaused ? t("Agent 已暂停运行。如因套餐到期，续费后即可恢复使用。")
    : startupFailed ? t("会话加载失败，请重试")
    : connection.failureCode === "intervention:authentication-required" ? t("登录已过期，请重新登录后重试")
    : connection.failureCode === "remote-resource-not-found" ? t("当前 AI 伙伴不可用，请检查运行状态")
    : connection.failureCode === "intervention:configuration-required" ? t("请检查 AI 伙伴状态后重试")
    : connection.phase === "error" ? t("连接暂时中断，正在尝试恢复…")
    : connectionSlow ? t("连接时间较长，请检查网络或重试")
    : presentedOwner === "opencraft" ? t("正在重新连接，输入内容已保留…")
    : null;

  return (
    <div
      aria-hidden={!active || undefined}
      className={cn(
        "min-h-0 overflow-hidden rounded-lg border border-black/[0.08] bg-white",
        enabled ? "h-full" : "h-[clamp(516px,calc(100vh-220px),960px)] lg:h-full",
        enabled && "rounded-none border-0",
        active ? "relative" : "invisible pointer-events-none absolute inset-0",
      )}
      inert={active ? undefined : true}
    >
      <div
        ref={legacyRef}
        aria-hidden={!active || presentedOwner !== "legacy" || undefined}
        className={cn(
          "absolute inset-0 min-h-0 overflow-hidden",
          (!active || presentedOwner !== "legacy") && "invisible pointer-events-none",
        )}
        inert={!active || presentedOwner !== "legacy" ? true : undefined}
      >
        {presentedOwner === "legacy" ? legacy : null}
      </div>
      {unavailable && active && (
        <div className={cn(
          "absolute z-10 flex items-center justify-center gap-3 bg-white/95 px-4 py-3 text-sm text-black/60",
          presentedOwner === "loading" ? "inset-0 flex-col" : "inset-x-0 top-0 border-b border-black/[0.08]",
        )}>
          {connectionMessage === null ? (isCN ? <ChatLoadingState /> : (
            <span role="status">
              <span className="sr-only">{t("正在加载会话…")}</span>
              <span aria-hidden="true">
                {t("正在加载会话…").replace(/(?:…|\.{3})$/u, "")}
                <span className="inline-flex w-[1em] justify-between">{[0, 1, 2].map(dot => (
                  <span key={dot} className="motion-safe:animate-pulse" style={{ animationDelay: `${dot * 200}ms`, animationDuration: "1.2s" }}>.</span>
                ))}</span>
              </span>
            </span>
          )) : <span role="status">{connectionMessage}</span>}
          {!agentPaused && (startupFailed || connectionSlow || connection.phase === "error" || presentedOwner === "opencraft") && (
            <button type="button" disabled={retrying} onClick={() => { void retryConnection(); }}
              className="shrink-0 rounded-md border border-black/15 px-3 py-1 text-black/80 hover:bg-black/5 disabled:opacity-50">
              {retrying ? t("正在连接…") : t("重新连接")}
            </button>
          )}
        </div>
      )}
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
