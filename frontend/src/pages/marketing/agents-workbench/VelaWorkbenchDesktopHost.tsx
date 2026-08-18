"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useT } from "@/i18n/t";
import type { Bot } from "@/domain/types";
import type { BotRepository } from "@/repositories/types";
import type {
  BackendKindWire,
  BackendWire,
  SessionListItemWire,
} from "velachat/packages/vela-chat-client/src";
import {
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "velachat/packages/vela-chat-controller/src";
import type { ChatHostPolicy } from "velachat/packages/vela-chat-render-model/src";
import { ChatSurface, SessionListSurface } from "velachat/packages/vela-chat-web/src";

import { createWorkbenchDesktopHostStateStores } from "./host-state";
import styles from "./VelaWorkbenchDesktopHost.module.css";
import { buildVeladVmInstallCommand, hasVeladRelease } from "./velad-release";
import {
  createVmWorkbenchVeladTransport,
  type ResolvedWorkbenchVeladTransport,
} from "./velad-transport";

const DEFAULT_WORKING_DIRECTORY = "/";
const DEFAULT_BACKEND_STORAGE_KEY = "mono2-vela-workbench:settings:default-backend";
const WORKBENCH_BACKEND_PREFERENCE = ["acp", "codex", "pi"] satisfies BackendKindWire[];
const WORKBENCH_HOST_POLICY = { kind: "desktop_web" } satisfies ChatHostPolicy;

interface VelaWorkbenchDesktopHostProps {
  bot: Bot | null;
  botError: string | null;
  botLoading: boolean;
  execDebugCommand: BotRepository["execDebugCommand"];
  getTerminalSession: BotRepository["getTerminalSession"];
  onReloadBots: () => Promise<void> | void;
}

type WorkbenchBootstrap =
  | { status: "starting"; message: string }
  | { status: "failed"; error: string };

type AutoVeladBootstrap =
  | { botId: string; status: "running" }
  | { botId: string; status: "succeeded" }
  | { botId: string; status: "failed"; error: string };

type WorkbenchDesktopHostStateStores = ReturnType<
  typeof createWorkbenchDesktopHostStateStores
>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function VelaWorkbenchDesktopHost({
  bot,
  botError,
  botLoading,
  execDebugCommand,
  getTerminalSession,
  onReloadBots,
}: VelaWorkbenchDesktopHostProps) {
  const t = useT();
  const hostStateStores = useMemo(() => createWorkbenchDesktopHostStateStores(), []);
  const [transport, setTransport] = useState<ResolvedWorkbenchVeladTransport | null>(
    null,
  );
  const [bootstrap, setBootstrap] = useState<WorkbenchBootstrap>({
    status: "starting",
    message: botLoading ? t("正在加载 Agent…") : "",
  });
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [autoVeladBootstrap, setAutoVeladBootstrap] =
    useState<AutoVeladBootstrap | null>(null);

  const installVeladInVm = useCallback(
    async () => {
      if (!bot) return false;
      try {
        const command = buildVeladVmInstallCommand();
        const result = await execDebugCommand(bot.id, command);
        if (result.exitCode !== 0 || result.status.toUpperCase() !== "SUCCESS") {
          throw new Error(result.output || `velad install failed: ${result.status}`);
        }
        setAutoVeladBootstrap({ botId: bot.id, status: "succeeded" });
        setConnectAttempt((current) => current + 1);
        return true;
      } catch (err) {
        setAutoVeladBootstrap({
          botId: bot.id,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    [bot, execDebugCommand],
  );

  useEffect(() => {
    if (botError || !bot || !hasVeladRelease()) return undefined;
    if (autoVeladBootstrap?.botId === bot.id) {
      return undefined;
    }

    let cancelled = false;
    setAutoVeladBootstrap({ botId: bot.id, status: "running" });
    void installVeladInVm().then((succeeded) => {
      if (cancelled) return;
      setAutoVeladBootstrap(
        succeeded
          ? { botId: bot.id, status: "succeeded" }
          : {
              botId: bot.id,
              status: "failed",
              error: "Failed to start velad in VM.",
            },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [autoVeladBootstrap, bot, botError, installVeladInVm]);

  const autoVeladReady =
    !bot ||
    !hasVeladRelease() ||
    (autoVeladBootstrap?.botId === bot.id &&
      autoVeladBootstrap.status === "succeeded");

  useEffect(() => {
    if (botError) {
      setTransport(null);
      setBootstrap({ status: "failed", error: botError });
      return undefined;
    }
    if (!bot) {
      setTransport(null);
      setBootstrap({
        status: "starting",
        message: botLoading ? t("正在加载 Agent…") : t("暂无可用的 Agent。"),
      });
      return undefined;
    }
    if (!autoVeladReady) {
      setTransport(null);
      if (
        autoVeladBootstrap?.botId === bot.id &&
        autoVeladBootstrap.status === "failed"
      ) {
        setBootstrap({ status: "failed", error: autoVeladBootstrap.error });
        return undefined;
      }
      setBootstrap({
        status: "starting",
        message: t("正在虚拟机中启动 velad…"),
      });
      return undefined;
    }

    let cancelled = false;
    let nextTransport: ResolvedWorkbenchVeladTransport | null = null;
    setTransport(null);
    setBootstrap({
      status: "starting",
      message: "",
    });

    void createVmWorkbenchVeladTransport({
      botId: bot.id,
      getTerminalSession,
    })
      .then((resolvedTransport) => {
        if (cancelled) {
          resolvedTransport.close();
          return;
        }
        nextTransport = resolvedTransport;
        setTransport(resolvedTransport);
      })
      .catch((err) => {
        if (cancelled) return;
        setBootstrap({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      nextTransport?.close();
    };
  }, [
    autoVeladBootstrap,
    autoVeladReady,
    bot,
    botError,
    botLoading,
    connectAttempt,
    getTerminalSession,
  ]);

  const retry = useCallback(() => {
    void onReloadBots();
    setAutoVeladBootstrap(null);
    setConnectAttempt((current) => current + 1);
  }, [onReloadBots]);

  if (transport) {
    return (
      <WorkbenchEmbeddedReadyApp
        hostStateStores={hostStateStores}
        transport={transport}
      />
    );
  }

  return (
    <WorkbenchHostSurface
      error={bootstrap.status === "failed" ? bootstrap.error : null}
      isLoading={bootstrap.status === "starting"}
      onRetry={retry}
    />
  );
}

interface WorkbenchEmbeddedReadyAppProps {
  hostStateStores: WorkbenchDesktopHostStateStores;
  transport: ResolvedWorkbenchVeladTransport;
}

function WorkbenchEmbeddedReadyApp({
  hostStateStores,
  transport,
}: WorkbenchEmbeddedReadyAppProps) {
  const [activeSessionId, setActiveSessionId] = useState(
    () => hostStateStores.sessionSelectionStore?.read()?.sessionId ?? "",
  );
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">(
    readDefaultBackendPreference,
  );
  const [sessions, setSessions] = useState<SessionListItemWire[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [didAutoCreateSession, setDidAutoCreateSession] = useState(false);

  useEffect(() => {
    writeDefaultBackendPreference(selectedBackendKind);
  }, [selectedBackendKind]);

  useEffect(() => {
    if (!activeSessionId) return;
    hostStateStores.sessionSelectionStore?.write({
      sessionId: activeSessionId,
      updatedAt: Date.now(),
    });
  }, [activeSessionId, hostStateStores.sessionSelectionStore]);

  const client = transport.client;
  const controller = useVelaChatSession({
    client,
    baseUrl: transport.baseUrl,
    clientStateStore: hostStateStores.clientStateStore,
    eventStreamTransport: transport.eventStreamTransport,
    historyPolicy: "tail_only",
    hostPolicy: WORKBENCH_HOST_POLICY,
    sessionId: activeSessionId,
  });
  const setup = useMemo(
    () =>
      buildVelaSessionSetupSelection({
        backends: controller.backends,
        selectedBackend: selectedBackendKind,
        preferredBackends: WORKBENCH_BACKEND_PREFERENCE,
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [controller.backends, selectedBackendKind],
  );

  const loadSessions = useCallback(async () => {
    try {
      setIsLoadingSessions(true);
      setError(null);
      const response = await client.getSessionListView({ limit: 80 });
      setSessions(response.sessions);
      setActiveSessionId((current) =>
        current && response.sessions.some((session) => session.id === current)
          ? current
          : response.sessions[0]?.id || "",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsLoadingSessions(false);
    }
  }, [client]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const buildSessionSetup = useCallback(
    (backends: BackendWire[]) =>
      buildVelaSessionSetupSelection({
        backends,
        selectedBackend: selectedBackendKind,
        preferredBackends: WORKBENCH_BACKEND_PREFERENCE,
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [selectedBackendKind],
  );

  const resolveNewSessionSetup = useCallback(async () => {
    if (setup.resolvedSelectedBackend) return setup;
    const nextBackends = await client.getBackends();
    return buildSessionSetup(nextBackends.backends);
  }, [buildSessionSetup, client, setup]);

  const createSession = useCallback(async () => {
    try {
      setError(null);
      const nextSetup = await resolveNewSessionSetup();
      const backend = nextSetup.resolvedSelectedBackend;
      if (!backend) {
        setError(t("暂无可用后端，请等待 velad 启动完成后重试。"));
        return;
      }
      const created = await client.createSession({
        backend,
        agentConfig: nextSetup.setupAgentConfig,
        title: t("新对话"),
        workingDirectory: DEFAULT_WORKING_DIRECTORY,
      });
      setActiveSessionId(created.session.id);
      await loadSessions();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client, loadSessions, resolveNewSessionSetup]);

  useEffect(() => {
    if (isLoadingSessions || activeSessionId || didAutoCreateSession) return;
    if (!setup.resolvedSelectedBackend) return;

    setDidAutoCreateSession(true);
    void createSession();
  }, [
    activeSessionId,
    createSession,
    didAutoCreateSession,
    isLoadingSessions,
    setup.resolvedSelectedBackend,
  ]);

  return (
    <WorkbenchHostSurface
      activeSessionId={activeSessionId || null}
      error={controller.error ?? error}
      isLoading={isLoadingSessions || !activeSessionId}
      onCreateSession={createSession}
      onRetry={loadSessions}
      onSelectSession={setActiveSessionId}
      sessions={sessions}
    >
      {activeSessionId ? (
        <ChatSurface
          canLoadOlder={controller.canLoadOlder}
          clientStateStore={hostStateStores.clientStateStore}
          composerControls={controller.composerControls}
          draft={controller.draft}
          error={controller.error ?? error}
          historyPhase={controller.historyPhase}
          isLoadingOlder={controller.isLoadingOlder}
          isRespondingToRequest={controller.isRespondingToRequest}
          isUpdatingComposerControls={controller.isUpdatingAgentConfig}
          layout="contained"
          messageFollowToken={controller.messageFollowToken}
          model={controller.model}
          onAgentConfigChange={controller.updateAgentConfig}
          onAttachImages={controller.attachImages}
          onConversationScrollDebugChange={controller.setConversationScrollDebug}
          onDraftChange={controller.setDraft}
          onLoadOlder={controller.loadOlderConversation}
          onRemoveAttachment={controller.removeAttachment}
          onRespondToRequest={controller.respondToRequest}
          onStop={controller.stop}
          onSubmit={controller.send}
          pendingAttachments={controller.pendingAttachments}
        />
      ) : null}
    </WorkbenchHostSurface>
  );
}

function WorkbenchHostSurface({
  activeSessionId,
  children,
  error,
  isLoading,
  onCreateSession,
  onRetry,
  onSelectSession,
  sessions,
}: {
  activeSessionId?: string | null;
  children?: ReactNode;
  error: string | null;
  isLoading: boolean;
  onCreateSession?: () => void;
  onRetry: () => void;
  onSelectSession?: (sessionId: string) => void;
  sessions?: SessionListItemWire[];
}) {
  const t = useT();
  const visibleSessions = sessions ?? [];

  return (
    <section
      className={styles.hostSurface}
      data-vela-embedded-workbench
      aria-busy={isLoading && !error ? "true" : undefined}
    >
      {/* aria-label 固定为 "Vela sessions"：该字面量被 workbench-desktop-shell-boundary 测试锁定 */}
      <aside className={styles.sessionRail} aria-label="Vela sessions">
        <div className={styles.sessionRailTop}>
          <div>
            <div className={styles.eyebrow}>{t("工作台")}</div>
            <h2 className={styles.railTitle}>{t("Hermes宝宝")}</h2>
          </div>
          <button
            className={styles.iconButton}
            type="button"
            aria-label={t("刷新会话")}
            onClick={onRetry}
          >
            ↻
          </button>
        </div>

        <button
          className={styles.newChatButton}
          type="button"
          onClick={() => void onCreateSession?.()}
        >
          <span aria-hidden>+</span>
          <span>{t("新对话")}</span>
        </button>

        <div className={styles.sessionListRegion}>
          {visibleSessions.length > 0 && onSelectSession ? (
            <SessionListSurface
              currentSessionId={activeSessionId ?? null}
              sessions={visibleSessions}
              onSelectSession={onSelectSession}
            />
          ) : (
            <div className={styles.emptySessions}>
              {isLoading ? "" : "No sessions yet."}
            </div>
          )}
        </div>
      </aside>

      <div className={styles.chatPanel}>
      {error ? (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {children}
      </div>
    </section>
  );
}

function readDefaultBackendPreference(): BackendKindWire | "" {
  if (typeof window === "undefined") return "";
  const value = window.localStorage.getItem(DEFAULT_BACKEND_STORAGE_KEY);
  return isBackendKind(value) ? value : "";
}

function writeDefaultBackendPreference(value: BackendKindWire | "") {
  if (typeof window === "undefined") return;
  if (!value) {
    window.localStorage.removeItem(DEFAULT_BACKEND_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(DEFAULT_BACKEND_STORAGE_KEY, value);
}

function isBackendKind(value: string | null): value is BackendKindWire {
  return (
    value === "codex" ||
    value === "cloudagent" ||
    value === "claude_code" ||
    value === "pi" ||
    value === "opencode" ||
    value === "acp" ||
    value === "qoder"
  );
}
