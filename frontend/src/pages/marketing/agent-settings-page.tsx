import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  Check,
  Copy,
  Globe2,
  MessageCircle,
  MessageSquare,
  Loader2,
  MoreVertical,
  Calendar,
  Mail,
  Database,
  Sparkles,
  ExternalLink,
  X,
  ScanLine,
  AlertTriangle,
  Crown,
  TerminalSquare,
  Download,
  Files,
  Plus,
  RefreshCw,
  Stethoscope,
  Trophy,
  UploadCloud,
  UserRound,
  Wand2,
  Wrench,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, useId, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/asset-url";
import { ProductFooter, ProductReturnHomeHeader } from "@/components/site/product-chrome";
import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { useOpenClaw, type OpenClawBot } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { usePaidBillingEnabled, useRealnamePhoneVerificationEnabled } from "@/contexts/runtime-config-context";
import { useT, t as rawT } from "@/i18n/t";
import { useTranslation } from "react-i18next";
import { isCN, isGlobal } from "@/lib/region";
import type { IModelProvider } from "@tencent/tea-sdk-lightclaw";
import { useSession } from "@/contexts/session-context";
import { avatarImageUrl } from "@/lib/avatar-image";
import { AppLink, useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { AUTH_SERVICE_UNAVAILABLE_MESSAGE, readStoredAuthToken } from "@/repositories/http-repositories";
import {
  AGENTS_HOME_PATH,
  AGENT_SECTION_PATH_BY_ID,
  getAgentSectionHref,
  type AgentSettingsSectionId,
} from "@/lib/agent-routes";
import type { WorkerActionStatusResult } from "@/repositories/types";
import {
  createMonoDebugExecAdapter,
} from "@/pages/marketing/agent-tat-adapter";
import { composeDebugExecCommandLifecycles } from "@/pages/marketing/agent-debug-exec-lifecycle";
import { getAgentCreateErrorMessage } from "@/pages/marketing/agent-create-error";
import { useAutomationAwareModelSwitch } from "@/pages/marketing/agent-model-switch-automation-sync";
import { createQqbotGroupPolicyCommandLifecycle } from "@/pages/marketing/agent-qqbot-group-policy";
import { createLightVelaCommandExecutor } from "@/pages/marketing/agent-command-executor";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/agent-console-helpers";
import {
  fetchHermesMemorySnapshot,
  getHermesMemoryLimitBounds,
  getMemoryUsagePercent,
  isHermesMemoryLimitNearUsage,
  splitHermesMemoryEntries,
  toSingleLineMemoryEntry,
  validateHermesMemoryLimit,
  type HermesMemorySnapshot,
  type HermesMemoryLimitTarget,
  type HermesMemoryLimitValidation,
} from "@/pages/marketing/agent-memory";
import {
  canStartHermesMemoryLimitSave,
  isHermesMemoryOperationCurrent,
  saveHermesMemoryLimit as executeHermesMemoryLimitSave,
} from "@/pages/marketing/agent-memory-save";
import { BuddyPanel } from "@/pages/marketing/agent-buddy-panel";
import { HermesAgentSkillsPanel } from "@/pages/marketing/agent-skills-panel";
import { AchievementsPanel } from "@/pages/marketing/agent-achievements-panel";
import { HermesAgentAutomationsPanel } from "@/pages/marketing/agent-automations-panel";
import { shouldShowAgentSettingsDataLoading } from "@/pages/marketing/agent-settings-loading";
import { StableTeaSdkPanelHost } from "@/pages/marketing/agent-settings-sdk-stable-host";
import {
  buildWorkspaceActionDisabledReason,
  describeWorkspaceActionError,
  getWorkspaceTaskPhaseLabel,
  isWorkspaceActionRunning,
  selectCurrentWorkspaceTask,
  shouldShowWorkspaceRecoveryPanel,
  type WorkspaceActionKind,
} from "@/pages/marketing/agent-workspace-recovery";
import { findCompletedCreatingBot, getOpenClawCreateLimitMessage } from "@/pages/marketing/agent-create-availability";
import {
  getRestartBlockReason,
  isActiveBotRestarting as computeIsActiveBotRestarting,
  getActiveBotRestartError,
  buildRestartErrorMessage,
  setErrorForBot,
  clearErrorForBot,
  type RestartErrors,
} from "@/pages/marketing/agent-restart-gateway";
import {
  getResetBlockReason,
  getAcliResetBlockReason,
  hermesModelName,
  hermesSwitchModelFullId,
  isExecCommandSucceeded,
  isResetConfigRouteMissingError,
  truncateExecOutput,
  ACLI_RESET_COMMAND,
  RESET_BLOCK_REASON,
} from "@/pages/marketing/agent-reset-config";
import { toast } from "@/lib/toast";
import { isPaidBillingEnabled } from "@/lib/billing-flow";
import { getPassExpiryReminder } from "@/lib/pass-renewal";
import { isRenewalRealnameVerified } from "@/lib/renewal-realname";
import { RenewPassModal } from "@/pages/marketing/renew-pass-modal";
import { trackDatongClick, trackDatongEvent } from "@/observability/datong-tracker";
import { DATONG_EVENTS, DATONG_PAGE_IDS } from "@/observability/datong";

const AgentChatPanel = lazy(() =>
  import("@/pages/marketing/agent-chat-panel").then((module) => ({ default: module.AgentChatPanel })),
);
const AgentDiagnosticsPanel = lazy(() =>
  import("@/pages/marketing/agent-diagnostics-panel").then((module) => ({ default: module.AgentDiagnosticsPanel })),
);
const TatFileManagerPanel = lazy(() =>
  import("@/components/domain/tat-file-manager-panel").then((module) => ({ default: module.TatFileManagerPanel })),
);
const TatHermesWebPanel = lazy(() =>
  import("@/components/domain/tat-hermes-web-panel").then((module) => ({ default: module.TatHermesWebPanel })),
);
const TerminalPanel = lazy(() =>
  import("@/pages/marketing/agent-terminal-panel").then((module) => ({ default: module.TerminalPanel })),
);

type TeaSdkInstanceInfo = {
  InstanceId: string;
  RegionId: number;
};

type TeaSdkFeatureFlags = {
  gateway: boolean;
  channel: boolean;
  wecomChannel: boolean;
  adpChannel: boolean;
  wecomLongConn: boolean;
  yuanbaoChannel: boolean;
  weixinChannel: boolean;
  qrConfig: boolean;
  skills: boolean;
  webUI: boolean;
  memoryManagement: boolean;
  memoryV2: boolean;
  qqbotplugin: boolean;
};

type TeaSdkProductConfig = {
  acliProduct: "lightvela";
  runCommand: unknown;
  getInvocationTask: unknown;
  [key: string]: unknown;
};

type TeaSdkPanelProps = {
  instance: TeaSdkInstanceInfo;
  featureFlags: TeaSdkFeatureFlags;
  productConfig: TeaSdkProductConfig;
};

type TeaSdkRuntime = {
  ChannelPanel: ComponentType<TeaSdkPanelProps>;
  ModelPanel: ComponentType<TeaSdkPanelProps>;
  /** SDK 的 useModelProviders hook（动态 import 获取，避免静态 import 破坏 SSG） */
  useModelProviders: (params?: {
    isI18n?: boolean;
    useEnglish?: boolean;
    rainbowBaseUrl?: string;
    app?: string;
  }) => IModelProvider[] | undefined;
  createProductConfig: (args: {
    runCommand: TeaSdkProductConfig["runCommand"];
    getInvocationTask: TeaSdkProductConfig["getInvocationTask"];
    modelProviders?: IModelProvider[];
  }) => TeaSdkProductConfig;
  getGatewayRestartCommand: () => string;
  getProviderSaveCommand: (config: {
    name: string;
    baseUrl: string;
    api: string;
    apiKey: string;
    models: Array<{ id: string; name: string }>;
  }) => string;
  getModelSwitchCommand: (modelFullId: string) => string;
};

let teaSdkRuntimePromise: Promise<TeaSdkRuntime> | null = null;
let teaSdkRuntimeCache: TeaSdkRuntime | null = null;
let teaSdkRuntimeError: Error | null = null;

function loadTeaSdkRuntime(): Promise<TeaSdkRuntime> {
  if (teaSdkRuntimeCache) {
    return Promise.resolve(teaSdkRuntimeCache);
  }
  if (!teaSdkRuntimePromise) {
    teaSdkRuntimePromise = (async () => {
      // Keep TEA SDK out of the module graph evaluated during Next static generation.
      // The SDK reads browser globals at module scope, so it must be initialized
      // only inside the hydrated agents page before its panels render.
      await import("@/lib/i18n-env");
      await import("@tencent/tea-sdk-lightclaw/styles");
      const [sdk, scriptsModule] = await Promise.all([
        import("@tencent/tea-sdk-lightclaw"),
        import("@tencent/tea-sdk-lightclaw/scripts"),
      ]);
      const lightVelaHermesScripts = scriptsModule.createLightClawScripts();
      const hermesScripts = lightVelaHermesScripts.hermes;
      const hermesGatewayCommands = hermesScripts.gateway;
      const hermesModelCommands = hermesScripts.model;
      const useModelProviders: TeaSdkRuntime["useModelProviders"] =
        typeof sdk.useModelProviders === "function"
          ? sdk.useModelProviders
          : () => undefined;

      const runtime: TeaSdkRuntime = {
        ChannelPanel: sdk.ChannelPanel as unknown as ComponentType<TeaSdkPanelProps>,
        ModelPanel: sdk.ModelPanel as unknown as ComponentType<TeaSdkPanelProps>,
        useModelProviders,
        createProductConfig: ({ runCommand, getInvocationTask, modelProviders }) => {
          const config = sdk.createLighthouseConfig({
            agentType: "hermes",
            supportsTencentCloudApi: false,
            isI18n: isGlobal,
            modelProviders,
          });
          // SDK 的 getFilteredModelProviderList 用 IS_I18N（来自 window.LOGIN_INFO.area）
          // 做国内/国际站过滤，但 mono2 不设置 window.LOGIN_INFO，导致 IS_I18N 恒为 false，
          // 国际站会错误隐藏 OpenAI/Anthropic 等海外 provider。这里用 mono2 的 isGlobal
          // 覆盖过滤逻辑，绕过 SDK 的模块级常量。
          const hiddenProviders = isGlobal
            ? sdk.I18N_HIDDEN_PROVIDERS
            : sdk.DOMESTIC_HIDDEN_PROVIDERS;
          return {
            ...config,
            acliProduct: "lightvela",
            runCommand,
            getInvocationTask,
            getFilteredModelProviders: (region?: string) => {
              const filtered = config.modelProviders.filter(
                (p) => !hiddenProviders.includes(p.value),
              );
              if (region === "ap-hongkong") {
                return filtered.filter(
                  (p) => !sdk.HK_REGION_HIDDEN_PROVIDERS.includes(p.value),
                );
              }
              return filtered;
            },
          };
        },
        getGatewayRestartCommand: () => hermesGatewayCommands.getRestartCommand(),
        getProviderSaveCommand: (config) => hermesModelCommands.getProviderSaveCommand(config),
        getModelSwitchCommand: (modelFullId) => hermesModelCommands.getModelSwitchCommand(modelFullId),
      };
      teaSdkRuntimeCache = runtime;
      teaSdkRuntimeError = null;
      return runtime;
    })().catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      teaSdkRuntimeError = normalizedError;
      teaSdkRuntimePromise = null;
      throw normalizedError;
    });
  }
  return teaSdkRuntimePromise;
}

function TeaSdkRuntimeLoading() {
  const t = useT();

  return (
    <div className="flex items-center justify-center rounded-md border border-black/[0.06] bg-white py-16 text-sm text-black/45">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {t("正在加载配置面板…")}
    </div>
  );
}

function TeaSdkSettingsPanel({
  kind,
  instance,
  featureFlags,
  productConfigArgs,
  useEnglish,
}: {
  kind: "channel" | "model";
  instance: TeaSdkInstanceInfo;
  featureFlags: TeaSdkFeatureFlags;
  productConfigArgs: {
    runCommand: TeaSdkProductConfig["runCommand"];
    getInvocationTask: TeaSdkProductConfig["getInvocationTask"];
  };
  /** 是否取英文文案（语言维度），传给 SDK useModelProviders */
  useEnglish: boolean;
}) {
  const t = useT();
  const [runtime, setRuntime] = useState<TeaSdkRuntime | null>(() => teaSdkRuntimeCache);
  const [error, setError] = useState<string | null>(() => teaSdkRuntimeError?.message ?? null);

  useEffect(() => {
    if (teaSdkRuntimeCache) {
      setRuntime(teaSdkRuntimeCache);
      setError(null);
      return;
    }
    let cancelled = false;
    void loadTeaSdkRuntime()
      .then((nextRuntime) => {
        if (!cancelled) setRuntime(nextRuntime);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
        {t("加载配置面板失败：{{message}}", { message: error })}
      </div>
    );
  }

  if (!runtime) {
    return <TeaSdkRuntimeLoading />;
  }

  return (
    <TeaSdkSettingsPanelReady
      runtime={runtime}
      kind={kind}
      instance={instance}
      featureFlags={featureFlags}
      productConfigArgs={productConfigArgs}
      useEnglish={useEnglish}
    />
  );
}

/** runtime 已就绪的内层组件，无条件调 hook（遵守 Rules of Hooks） */
function TeaSdkSettingsPanelReady({
  runtime,
  kind,
  instance,
  featureFlags,
  productConfigArgs,
  useEnglish,
}: {
  runtime: TeaSdkRuntime;
  kind: "channel" | "model";
  instance: TeaSdkInstanceInfo;
  featureFlags: TeaSdkFeatureFlags;
  productConfigArgs: {
    runCommand: TeaSdkProductConfig["runCommand"];
    getInvocationTask: TeaSdkProductConfig["getInvocationTask"];
  };
  useEnglish: boolean;
}) {
  const modelProviders = runtime.useModelProviders({ isI18n: isGlobal, useEnglish });
  const productConfig = useMemo(
    () => runtime.createProductConfig({ ...productConfigArgs, modelProviders }),
    [runtime, productConfigArgs, modelProviders],
  );

  const Panel = kind === "channel" ? runtime.ChannelPanel : runtime.ModelPanel;

  return (
    <StableTeaSdkPanelHost>
      <Panel
        instance={instance}
        featureFlags={featureFlags}
        productConfig={productConfig}
      />
    </StableTeaSdkPanelHost>
  );
}

/* ─── Types ─── */

const RepairToolsIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 1024 1024" aria-hidden="true" fill="none" {...props}>
    <path
      d="M258.56 76.8c-28.16 0-53.76 5.12-79.36 17.92-15.36 7.68-20.48 28.16-7.68 40.96l87.04 87.04-30.72 30.72-87.04-87.04c-5.12-5.12-10.24-7.68-17.92-7.68-10.24 0-17.92 5.12-23.04 15.36-33.28 66.56-23.04 151.04 33.28 207.36 35.84 35.84 79.36 51.2 125.44 51.2 20.48 0 40.96-2.56 58.88-10.24l284.16 284.16c-23.04 64-7.68 135.68 40.96 186.88 35.84 35.84 79.36 51.2 125.44 51.2 28.16 0 53.76-5.12 79.36-17.92 15.36-7.68 20.48-28.16 7.68-40.96l-87.04-87.04 30.72-30.72 87.04 87.04c5.12 5.12 10.24 7.68 17.92 7.68 10.24 0 17.92-5.12 23.04-15.36 33.28-66.56 23.04-151.04-33.28-207.36-35.84-35.84-79.36-51.2-125.44-51.2-20.48 0-40.96 2.56-61.44 10.24l-284.16-284.16c23.04-64 7.68-135.68-40.96-186.88-33.28-33.28-76.8-51.2-122.88-51.2z m-33.28 230.4c12.8 0 25.6-5.12 35.84-15.36l30.72-30.72c20.48-20.48 20.48-51.2 0-71.68l-58.88-58.88c7.68 0 15.36-2.56 23.04-2.56 33.28 0 66.56 12.8 89.6 38.4 35.84 35.84 46.08 87.04 30.72 133.12-7.68 17.92-2.56 38.4 12.8 53.76l284.16 284.16c10.24 10.24 23.04 15.36 35.84 15.36 5.12 0 12.8 0 17.92-2.56 12.8-5.12 28.16-7.68 43.52-7.68 33.28 0 66.56 12.8 89.6 38.4 30.72 30.72 43.52 71.68 35.84 112.64l-58.88-58.88c-10.24-10.24-23.04-15.36-35.84-15.36-12.8 0-25.6 5.12-35.84 15.36l-30.72 30.72c-10.24 10.24-15.36 23.04-15.36 35.84s5.12 25.6 15.36 35.84l58.88 58.88c-7.68 0-15.36 2.56-23.04 2.56-33.28 0-66.56-12.8-89.6-38.4-35.84-35.84-46.08-87.04-30.72-133.12 7.68-17.92 2.56-38.4-12.8-53.76l-284.16-284.16c-10.24-10.24-23.04-15.36-35.84-15.36-5.12 0-10.24 0-17.92 2.56-12.8 5.12-28.16 7.68-43.52 7.68-33.28 0-66.56-12.8-89.6-38.4-30.72-30.72-43.52-71.68-35.84-112.64l58.88 58.88c10.24 10.24 23.04 15.36 35.84 15.36z"
      fill="currentColor"
    />
    <path
      d="M337.92 563.2c-12.8 0-25.6 5.12-35.84 15.36l-184.32 184.32c-20.48 20.48-20.48 51.2 0 71.68l71.68 71.68c10.24 10.24 23.04 15.36 35.84 15.36 12.8 0 25.6-5.12 35.84-15.36l184.32-184.32c20.48-20.48 20.48-51.2 0-71.68l-71.68-71.68c-7.68-10.24-20.48-15.36-35.84-15.36z m-110.08 307.2l-71.68-71.68 184.32-184.32 71.68 71.68-184.32 184.32zM849.92 138.24l35.84 35.84-89.6 89.6-17.92-17.92-17.92-17.92 89.6-89.6m0-61.44c-7.68 0-12.8 2.56-17.92 7.68l-125.44 125.44c-10.24 10.24-10.24 25.6 0 35.84l17.92 17.92-125.44 125.44c-10.24 10.24-10.24 25.6 0 35.84 5.12 5.12 12.8 7.68 17.92 7.68s12.8-2.56 17.92-7.68l125.44-125.44 17.92 17.92c5.12 5.12 12.8 7.68 17.92 7.68s12.8-2.56 17.92-7.68l125.44-125.44c10.24-10.24 10.24-25.6 0-35.84l-71.68-71.68c-2.56-5.12-10.24-7.68-17.92-7.68z"
      fill="currentColor"
    />
  </svg>
);

const SETTINGS_ICON_TOOLTIP_ARROW_CLASS =
  "absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white";

function WorkspaceActionTooltip({ children, content }: { children: ReactNode; content?: ReactNode }) {
  const tooltipId = useId();
  if (!content) return <>{children}</>;

  return (
    <span
      className="group relative inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30"
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      {children}
      <span className="absolute bottom-full left-0 h-2 w-full" aria-hidden="true" />
      <span
        id={tooltipId}
        role="tooltip"
        className="invisible pointer-events-auto absolute bottom-full left-1/2 z-20 mb-2 w-72 -translate-x-1/2 rounded-md border border-[var(--border-subtle)] bg-white px-3 py-2 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {content}
        <span className={SETTINGS_ICON_TOOLTIP_ARROW_CLASS} />
      </span>
    </span>
  );
}
type Channel = "wechat" | "qq" | null;
type ConnectedChannel = Exclude<Channel, null>;
type PersonaId = "jarvis" | "luna" | "spark";
type MemoryTabId = "memory" | "user";
type MemoryLoadStatus = "idle" | "loading" | "ready" | "error";

interface Persona {
  id: PersonaId;
  name: string;
  nameEn: string;
  desc: string;
  icon: string;
  skills: { name: string; desc: string; icon: React.ReactNode }[];
}

interface DebugExecStreamResponse {
  status?: string;
  exit_code?: number;
  output?: string;
}

interface DebugExecStreamEvent {
  type?: string;
  stream?: string;
  chunk?: string;
  response?: DebugExecStreamResponse;
}

interface DebugExecStreamResult {
  status: string;
  exitCode: number;
  output: string;
}

function parseSsePart(part: string): { eventType: string; data: string } | null {
  const lines = part.split("\n");
  let eventType = "";
  const dataLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  return { eventType, data: dataLines.join("\n") };
}

async function execDebugCommandStream(
  botId: string,
  command: string,
  onChunk: (event: { stream: string; chunk: string }) => void,
): Promise<DebugExecStreamResult> {
  const baseUrl = resolveConfiguredAuthApiBaseUrl();
  if (!baseUrl) {
    throw new Error(AUTH_SERVICE_UNAVAILABLE_MESSAGE);
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
  });
  const authToken = readStoredAuthToken();
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/instances/${encodeURIComponent(botId)}/debug/exec`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ command, "run_as_user": "agentuser" }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      detail = body.message?.trim() || body.error?.trim() || "";
    } catch {
      detail = "";
    }
    throw new Error(detail || `请求失败（${response.status}）`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Command output stream is not readable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let finalResponse: DebugExecStreamResponse | null = null;
  let sawErrorEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const parsedPart = parseSsePart(part);
      if (!parsedPart) continue;
      let event: DebugExecStreamEvent;
      try {
        event = JSON.parse(parsedPart.data) as DebugExecStreamEvent;
      } catch {
        continue;
      }
      const eventType = event.type || parsedPart.eventType;
      if ((eventType === "stdout" || eventType === "stderr") && event.chunk) {
        output += event.chunk;
        onChunk({ stream: event.stream || eventType, chunk: event.chunk });
      }
      if ((eventType === "finished" || eventType === "error") && event.response) {
        finalResponse = event.response;
      }
      if (eventType === "error") {
        sawErrorEvent = true;
      }
    }
  }

  if (finalResponse) {
    return {
      status: finalResponse.status || "FAILED",
      exitCode: typeof finalResponse.exit_code === "number" ? finalResponse.exit_code : -1,
      output: finalResponse.output || output,
    };
  }
  return { status: output && !sawErrorEvent ? "SUCCESS" : "FAILED", exitCode: output && !sawErrorEvent ? 0 : -1, output };
}

/* ─── Data ─── */

// 工厂函数：在调用时才读取 i18n 词条，避免模块加载顺序问题
function makePersonas(): Persona[] {
  const taskSchedule = {
    name: "Task Schedule",
    desc: rawT("智能日程管理与任务调度，自动规划每日待办并发送提醒"),
    icon: <Calendar className="h-5 w-5" />,
  };
  const emailAssistant = {
    name: "Email Assistant",
    desc: rawT("邮件智能撰写，分类归档与定时发送"),
    icon: <Mail className="h-5 w-5" />,
  };
  const dataPipeline = {
    name: "Data Pipeline",
    desc: rawT("ETL 数据管道自动化，多源数据聚合清洗与报表生成"),
    icon: <Database className="h-5 w-5" />,
  };
  return [
    {
      id: "jarvis",
      name: rawT("贾维斯"),
      nameEn: "Jarvis",
      desc: rawT("冷静理性的全能AI管家，高效精准地完成每一项任务"),
      icon: "🤖",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
    {
      id: "luna",
      name: rawT("露娜"),
      nameEn: "Luna",
      desc: rawT("温柔体贴的月光精灵，用温柔话语治愈你的每一天"),
      icon: "🌙",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
    {
      id: "spark",
      name: rawT("火花"),
      nameEn: "Spark",
      desc: rawT("充满激情的创意伙伴，总能带来意想不到的灵感碰撞"),
      icon: "🔥",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
  ];
}

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 24, filter: "blur(4px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

const _staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.15, delayChildren: 0.1 } },
};
void _staggerContainer;

/* ─── Navbar ─── */

const SHOW_AGENTCHAT_ENTRY = true;
const DEFAULT_AGENT_SECTION: AgentSettingsSectionId = "channel";

/* ─── Section Card Wrapper ─── */

export const _SectionCard = ({ title, icon, headerRight, children }: { title: string; icon: React.ReactNode; headerRight?: React.ReactNode; children: React.ReactNode }) => {
  if (isGlobal) return null;
  return (
    <motion.div
      variants={fadeIn}
      className="overflow-hidden rounded-2xl"
      style={{
        border: "1px solid rgba(0,0,0,0.06)",
        background: "#ffffff",
        boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
      }}
    >
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
        <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.90)" }}>
          {icon}
        </div>
        <h3 className="flex-1 text-base font-semibold" style={{ color: "rgba(0,0,0,0.90)", letterSpacing: "-0.2px" }}>{title}</h3>
        {headerRight}
      </div>
      <div className="p-6">
        {children}
      </div>
    </motion.div>
  );
}

function getMemoryLimitValidationMessage(
  validation: HermesMemoryLimitValidation,
  t: (zh: string, options?: Record<string, unknown>) => string,
): string | null {
  if (validation.ok) return null;

  switch (validation.reason) {
    case "empty":
      return t("请输入范围在 {{min}}-{{max}} 的数字", { min: validation.min, max: validation.max });
    case "integer":
      return t("请输入整数。");
    case "too_small":
      return t("最小不能低于 {{min}} 字符。", { min: validation.min });
    case "too_large":
      return t("最大不能超过 {{max}} 字符。", { max: validation.max });
  }

  return null;
}

const MemoryLimitCard = ({
  target,
  title,
  description,
  used,
  limit,
  isSaving,
  isDisabled,
  saveError,
  onSaveLimit,
  onDraftChange,
  t,
}: {
  target: HermesMemoryLimitTarget;
  title: string;
  description: string;
  used: number;
  limit: number;
  isSaving: boolean;
  isDisabled: boolean;
  saveError: string | null;
  onSaveLimit: (target: HermesMemoryLimitTarget, value: number, existingChars: number) => Promise<boolean>;
  onDraftChange: (target: HermesMemoryLimitTarget) => void;
  t: (zh: string, options?: Record<string, unknown>) => string;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLimit, setDraftLimit] = useState(String(limit));
  const [touched, setTouched] = useState(false);
  const percent = getMemoryUsagePercent(used, limit);
  const bounds = getHermesMemoryLimitBounds(target, used);
  const validation = validateHermesMemoryLimit(target, draftLimit, used);
  const validationMessage = touched ? getMemoryLimitValidationMessage(validation, t) : null;
  const displayError = validationMessage || (isEditing ? saveError : null);
  const shouldWarnNearUsage = validation.ok && isHermesMemoryLimitNearUsage(validation.value, used, limit);
  const helperTone = displayError ? "text-red-600" : shouldWarnNearUsage ? "text-amber-600" : "text-black/40";
  const helperMessage = displayError
    || (shouldWarnNearUsage
      ? t("新上限接近当前用量，后续记忆可能无法继续写入或触发自动淘汰。")
      : t("可设置范围：{{min}}-{{max}} 字符。保存后会重启 Hermes Agent 网关，可能短暂中断会话。", { min: bounds.min, max: bounds.max }));

  useEffect(() => {
    if (!isEditing) {
      setDraftLimit(String(limit));
      setTouched(false);
    }
  }, [isEditing, limit]);

  const handleCancel = () => {
    setIsEditing(false);
    setDraftLimit(String(limit));
    setTouched(false);
  };

  const handleSave = async () => {
    setTouched(true);
    if (!validation.ok) return;
    const saved = await onSaveLimit(target, validation.value, used);
    if (saved) {
      setIsEditing(false);
    }
  };

  return (
    <div className="rounded-lg border border-black/[0.06] bg-white p-4 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-black/85">{title}</p>
          <p className="mt-1 max-w-lg text-pretty text-xs leading-relaxed text-black/45">{description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-1 text-xs font-medium text-black/60">
          {percent}%
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="text-2xl font-semibold tabular-nums text-black/90">{used}</span>
        <span className="text-sm tabular-nums text-black/45">/</span>
        {isEditing ? (
          <input
            type="number"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={draftLimit}
            onBlur={() => setTouched(true)}
            onWheel={(event) => event.currentTarget.blur()}
            onChange={(event) => {
              setDraftLimit(event.target.value);
              setTouched(true);
              onDraftChange(target);
            }}
            disabled={isDisabled}
            className="h-9 w-28 rounded-md border border-black/[0.10] bg-white px-3 text-sm tabular-nums text-black/85 outline-none transition-colors focus:border-black/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        ) : (
          <span className="text-sm tabular-nums text-black/45">{limit}</span>
        )}
        <span className="text-sm text-black/45">{t("字符")}</span>
        {!isEditing && <span className="text-xs text-black/45">{t("当前占用 / 字符限额")}</span>}
        {!isEditing ? (
          <button
            type="button"
            onClick={() => {
              setDraftLimit(String(limit));
              setTouched(false);
              setIsEditing(true);
            }}
            disabled={isDisabled}
            className={cn(
              "ml-1 inline-flex h-7 items-center rounded-md border border-black/[0.10] bg-white px-2.5 text-xs font-medium text-black/55 transition-colors hover:border-black/[0.18] hover:bg-black/[0.04] hover:text-black/80",
              isDisabled && "cursor-not-allowed opacity-45",
            )}
          >
            {t("调整限额")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={isDisabled || !validation.ok}
              className={cn(
                "ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-black px-3 text-xs font-medium text-white transition-colors hover:bg-black/85",
                (isDisabled || !validation.ok) && "cursor-not-allowed opacity-45",
              )}
            >
              {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isSaving ? t("保存中...") : t("保存")}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isDisabled}
              className={cn(
                "inline-flex h-8 items-center rounded-md border border-black/[0.08] bg-white px-3 text-xs font-medium text-black/55 transition-colors hover:bg-black/[0.04] hover:text-black/75",
                isDisabled && "cursor-not-allowed opacity-45",
              )}
            >
              {t("取消")}
            </button>
          </>
        )}
      </div>
      {isEditing && (
        <p className={cn("mt-3 text-xs leading-relaxed", helperTone)}>
          {helperMessage}
        </p>
      )}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
        <div
          className="h-full rounded-full bg-black/80 transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

const MemoryEntries = ({
  entries,
  emptyText,
}: {
  entries: string[];
  emptyText: string;
}) => {
  if (entries.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-black/[0.10] bg-black/[0.015] px-6 text-center text-sm text-black/45">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => {
        const preview = toSingleLineMemoryEntry(entry);
        return (
          <div
            key={`${index}-${preview.slice(0, 24)}`}
            title={entry}
            className="flex min-h-11 items-center rounded-md border border-black/[0.06] bg-white px-3 text-sm text-black/75 shadow-[0_1px_2px_rgba(15,23,42,0.02)]"
          >
            <span className="min-w-0 flex-1 truncate">{preview}</span>
          </div>
        );
      })}
    </div>
  );
};

const MemoryPanel = ({
  status,
  snapshot,
  error,
  activeTab,
  onTabChange,
  onRefresh,
  onSaveLimit,
  onDraftChange,
  savingLimitTarget,
  limitSaveError,
  t,
}: {
  status: MemoryLoadStatus;
  snapshot: HermesMemorySnapshot | null;
  error: string | null;
  activeTab: MemoryTabId;
  onTabChange: (tab: MemoryTabId) => void;
  onRefresh: () => void;
  onSaveLimit: (target: HermesMemoryLimitTarget, value: number, existingChars: number) => Promise<boolean>;
  onDraftChange: (target: HermesMemoryLimitTarget) => void;
  savingLimitTarget: HermesMemoryLimitTarget | null;
  limitSaveError: { target: HermesMemoryLimitTarget; message: string } | null;
  t: (zh: string, options?: Record<string, unknown>) => string;
}) => {
  const memoryEntries = splitHermesMemoryEntries(snapshot?.memoryText ?? "");
  const userEntries = splitHermesMemoryEntries(snapshot?.userText ?? "");
  const visibleEntries = activeTab === "memory" ? memoryEntries : userEntries;
  const isLoading = status === "loading";

  return (
    <div className="space-y-4">
      <AgentSectionHeader
        title={t("持久记忆")}
        description={t("查看当前 Hermes Agent 的记忆和用户画像文件")}
        actions={(
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md border border-black/[0.08] bg-white px-3 text-sm font-medium text-black/70 transition-colors hover:bg-black/[0.035] hover:text-black/90",
              isLoading && "cursor-not-allowed opacity-60",
            )}
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("刷新")}
          </button>
        )}
      />

      {status === "error" && (
        <div className="rounded-lg border border-red-500/15 bg-red-500/[0.04] px-4 py-3 text-sm leading-relaxed text-red-600">
          {error || t("记忆读取失败，请稍后重试。")}
        </div>
      )}

      {isLoading && !snapshot && (
        <div className="flex min-h-64 items-center justify-center rounded-lg border border-black/[0.06] bg-white text-sm text-black/50">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t("正在读取记忆...")}
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <MemoryLimitCard
              target="memory"
              title={t("记忆统计")}
              description={t("MEMORY.md：跨会话长期记忆文件，主要保存项目环境事实、工作约定和经验教训等。")}
              used={snapshot.memoryChars}
              limit={snapshot.memoryCharLimit}
              isSaving={savingLimitTarget === "memory"}
              isDisabled={savingLimitTarget !== null}
              saveError={limitSaveError?.target === "memory" ? limitSaveError.message : null}
              onSaveLimit={onSaveLimit}
              onDraftChange={onDraftChange}
              t={t}
            />
            <MemoryLimitCard
              target="user"
              title={t("用户画像统计")}
              description={t("USER.md：帮 Agent 长期记住你的偏好、使用习惯和沟通方式。")}
              used={snapshot.userChars}
              limit={snapshot.userCharLimit}
              isSaving={savingLimitTarget === "user"}
              isDisabled={savingLimitTarget !== null}
              saveError={limitSaveError?.target === "user" ? limitSaveError.message : null}
              onSaveLimit={onSaveLimit}
              onDraftChange={onDraftChange}
              t={t}
            />
          </div>

          {snapshot.usedFallbackLimits && (
            <p className="text-xs text-black/40">
              {t("未读取到完整限额配置，当前展示默认值。")}
            </p>
          )}

          <div className="rounded-lg border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
            <div className="mb-3 inline-flex rounded-lg bg-black/[0.04] p-1">
              {([
                ["memory", t("记忆")],
                ["user", t("用户画像")],
              ] as const).map(([tab, label]) => {
                const isActive = activeTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => onTabChange(tab)}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive ? "bg-white text-black/90 shadow-sm" : "text-black/50 hover:text-black/80",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <MemoryEntries
              entries={visibleEntries}
              emptyText={activeTab === "memory" ? t("暂无 Agent 记忆。") : t("暂无用户画像。")}
            />
          </div>
        </>
      )}
    </div>
  );
};

/* ─── Delete Confirm Dialog ─── */

export const _DeleteConfirmDialog = ({ botName, onConfirm, onCancel }: { botName: string; onConfirm: () => void; onCancel: () => void }) => {
  const t = useT();
  if (isGlobal) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
        style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(207,61,76,0.08)" }}>
          <AlertTriangle className="h-6 w-6" style={{ color: "#cf3d4c" }} />
        </div>
        <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("确认删除")}</h3>
        <p className="mb-6 text-center text-sm leading-relaxed text-[var(--text-secondary)]">
          {t("确定要删除龙虾 {{name}} 吗？此操作不可撤销。", { name: `"${botName}"` })}
        </p>
        <div className="flex w-full gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}
          >
            {t("取消")}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-full px-4 py-2.5 text-sm font-bold text-white transition-colors hover:opacity-90"
            style={{ background: "#cf3d4c" }}
          >
            {t("确认删除")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Limit Reached Dialog ─── */

export const _LimitReachedDialog = ({ maxBots, planName, onClose }: { maxBots: number; planName: string; onClose: () => void }) => {
  const t = useT();
  if (isGlobal) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
        style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(230,111,98,0.08)" }}>
          <Crown className="h-6 w-6" style={{ color: "var(--lw-accent)" }} />
        </div>
        <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("已达创建上限")}</h3>
        <p className="mb-2 text-center text-sm leading-relaxed text-[var(--text-secondary)]">
          {t("当前 {{plan}} 套餐最多可创建 {{max}} 只龙虾，你已达到上限。", { plan: planName, max: String(maxBots) })}
        </p>
        <div className="flex w-full gap-3" style={{ marginTop: 25 }}>
          <button
            onClick={onClose}
            className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}
          >
            {t("我知道了")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Channel Section ─── */

type WeixinSessionStatus = "idle" | "creating" | "starting" | "waiting_qr" | "scanned" | "success" | "failed" | "expired" | "cancelled" | "timeout";

export const ChannelSection = () => {
  const t = useT();
  const repositories = useRepositories();
  const { bots, updateBot } = useOpenClaw();
  const configurableBots = useMemo(
    () => bots.filter((bot) => bot.status !== "provisioning" && bot.status !== "deleting"),
    [bots],
  );
  const [selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [qqAccount, setQqAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);

  /* ── WeChat login session state ── */
  const [showQrModal, setShowQrModal] = useState(false);
  const [wxSessionId, setWxSessionId] = useState("");
  const [wxStatus, setWxStatus] = useState<WeixinSessionStatus>("idle");
  const [wxQrUrl, setWxQrUrl] = useState("");
  const [wxError, setWxError] = useState<string | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);

  const selectedBot = configurableBots.find((bot) => bot.id === selectedBotId) ?? null;
  const connectedChannels: ConnectedChannel[] = selectedBot?.connectedChannels ?? [];

  useEffect(() => {
    if (!configurableBots.length) {
      setSelectedBotId("");
      return;
    }

    if (!selectedBotId || !configurableBots.some((bot) => bot.id === selectedBotId)) {
      setSelectedBotId(configurableBots[0]!.id);
    }
  }, [configurableBots, selectedBotId]);

  useEffect(() => {
    setChannelNotice(null);
  }, [selectedBotId]);

  /* ── 关闭弹窗时取消 SSE 和 session ── */
  const cleanupWeixinSession = useCallback(() => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
    }
    if (wxSessionId && selectedBot && wxStatus !== "success" && wxStatus !== "cancelled" && wxStatus !== "failed") {
      void repositories.bots.cancelWeixinLoginSession(selectedBot.id, wxSessionId).catch(() => { });
    }
  }, [wxSessionId, selectedBot, wxStatus, repositories.bots]);

  const closeQrModal = useCallback(() => {
    cleanupWeixinSession();
    setShowQrModal(false);
    setWxSessionId("");
    setWxStatus("idle");
    setWxQrUrl("");
    setWxError(null);
  }, [cleanupWeixinSession]);

  /* ── 启动微信扫码流程 ── */
  const handleWechatAuth = useCallback(async () => {
    if (!selectedBot) {
      setChannelNotice(t("请先创建并选择一个 Hermes Agent，再接入通道。"));
      return;
    }

    trackDatongClick("channel_connect_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
      params: { bot_id: selectedBot.id, channel_type: "wechat" },
    });
    setShowQrModal(true);
    setWxStatus("creating");
    setWxQrUrl("");
    setWxError(null);

    try {
      const { sessionId } = await repositories.bots.createWeixinLoginSession(selectedBot.id);
      setWxSessionId(sessionId);
      setWxStatus("starting");

      /* 订阅 SSE 事件流 */
      const abortController = new AbortController();
      sseAbortRef.current = abortController;

      const events = repositories.bots.subscribeWeixinLoginSessionEvents(
        selectedBot.id,
        sessionId,
        abortController.signal,
      );

      for await (const { event, data } of events) {
        if (abortController.signal.aborted) break;

        const payload = data as {
          session_id?: string;
          status?: string;
          qr_url?: string;
          qr_ascii?: string;
          error?: string;
          error_message?: string;
          restart_status?: string;
          data?: {
            status?: string;
            qr_url?: string;
            qr_ascii?: string;
            error_message?: string;
            restart_status?: string;
          };
        };

        /* SSE 事件的 data 字段里可能嵌套了一个 data 子对象 */
        const resolved = payload.data ?? payload;
        const newStatus = (resolved.status ?? "") as WeixinSessionStatus;
        const qrUrl = resolved.qr_url ?? "";
        const errorMsg = resolved.error_message ?? payload.error ?? "";

        if (qrUrl) {
          setWxQrUrl(qrUrl);
        }

        if (newStatus) {
          setWxStatus(newStatus);
        }

        if (errorMsg && (newStatus === "failed" || event === "error")) {
          setWxError(errorMsg);
        }

        /* 成功：更新 bot 的 connectedChannels */
        if (newStatus === "success") {
          const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("wechat")
            ? selectedBot.connectedChannels
            : [...selectedBot.connectedChannels, "wechat"];
          updateBot(selectedBot.id, { connectedChannels: nextChannels });
          break;
        }

        /* 终态：停止监听 */
        if (["failed", "expired", "cancelled", "timeout"].includes(newStatus) || event === "finished" || event === "error") {
          break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setWxStatus("failed");
        setWxError(err instanceof Error ? err.message : t("微信登录会话创建失败"));
      }
    }
  }, [selectedBot, repositories.bots, updateBot]);

  /* ── 如果 SSE 没有可用，降级为轮询 ── */
  useEffect(() => {
    if (wxStatus !== "starting" || !wxSessionId || !selectedBot) return;

    /* 给 SSE 3 秒时间建立连接，如果 3s 后状态仍然是 starting 且没有 qr_url，开始轮询 */
    const fallbackTimer = setTimeout(async () => {
      if (wxStatus !== "starting" && wxStatus !== "waiting_qr") return;
      if (wxQrUrl) return;

      const pollInterval = 3000;
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        if (!showQrModal) break;
        try {
          const snapshot = await repositories.bots.getWeixinLoginSession(selectedBot.id, wxSessionId);
          const status = (snapshot.status ?? "") as WeixinSessionStatus;
          if (snapshot.qr_url) setWxQrUrl(snapshot.qr_url);
          if (status) setWxStatus(status);
          if (snapshot.error_message) setWxError(snapshot.error_message);
          if (status === "success") {
            const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("wechat")
              ? selectedBot.connectedChannels
              : [...selectedBot.connectedChannels, "wechat"];
            updateBot(selectedBot.id, { connectedChannels: nextChannels });
            break;
          }
          if (["failed", "expired", "cancelled", "timeout"].includes(status)) break;
        } catch {
          /* 轮询失败时静默忽略 */
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxStatus, wxSessionId]);

  /* ── 组件卸载时清理 ── */
  useEffect(() => {
    return () => {
      if (sseAbortRef.current) {
        sseAbortRef.current.abort();
        sseAbortRef.current = null;
      }
    };
  }, []);

  const handleQqSubmit = async () => {
    if (!selectedBot || !qqAppId.trim() || !qqAppSecret.trim()) {
      return;
    }

    trackDatongClick("channel_connect_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
      params: { bot_id: selectedBot.id, channel_type: "qq" },
    });
    setSubmitting(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(selectedBot.id, {
        appId: qqAppId,
        appSecret: qqAppSecret,
        account: qqAccount || undefined,
      });
      trackDatongEvent(DATONG_EVENTS.CHANNEL_CONNECT_SUCCESS, {
        pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
        params: { bot_id: selectedBot.id, channel_type: "qq" },
      });
      const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("qq")
        ? selectedBot.connectedChannels
        : [...selectedBot.connectedChannels, "qq"];
      updateBot(selectedBot.id, { connectedChannels: nextChannels });
      setSelectedChannel(null);
      setQqAppId("");
      setQqAppSecret("");
      setQqAccount("");
      setChannelNotice(result.gatewayRestarted ? t("QQ channel 已配置，gateway 已重启。") : t("QQ channel 已配置，但 gateway 未确认重启。"));
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : t("QQ channel 配置失败"));
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 微信扫码状态对应的 UI 文案 ── */
  const wxStatusLabel: Record<string, { text: string; color: string }> = {
    creating: { text: t("正在创建登录会话…"), color: "#999" },
    starting: { text: t("正在启动微信登录…"), color: "#999" },
    waiting_qr: { text: t("请使用微信扫描二维码"), color: "#07C160" },
    scanned: { text: t("已扫码，正在确认登录…"), color: "#07C160" },
    success: { text: t("微信通道接入成功！"), color: "#07C160" },
    failed: { text: t("登录失败"), color: "#cf3d4c" },
    expired: { text: t("二维码已过期"), color: "#C67B1E" },
    cancelled: { text: t("已取消"), color: "#999" },
    timeout: { text: t("登录超时"), color: "#C67B1E" },
  };

  // 国内站封存组件：所有 hooks 调用完毕后再做国际站短路（遵循 React Hooks 调用顺序规则）
  if (isGlobal) return null;

  return (
    <>
      {/* WeChat QR Code Modal - 使用 Portal 渲染到 body */}
      {showQrModal && createPortal(
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
            onClick={closeQrModal}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
              style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(238,238,238,0.4)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={closeQrModal}
                className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--lw-bg-secondary)] text-[var(--text-tertiary)]"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.1)" }}>
                {wxStatus === "success" ? (
                  <Check className="h-6 w-6" style={{ color: "#07C160" }} />
                ) : (
                  <ScanLine className="h-6 w-6" style={{ color: "#07C160" }} />
                )}
              </div>
              <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("微信扫码接入")}</h3>

              {/* 状态提示 */}
              <p className="mb-4 text-center text-sm font-medium" style={{ color: wxStatusLabel[wxStatus]?.color ?? "#999" }}>
                {wxStatusLabel[wxStatus]?.text ?? t("准备中…")}
              </p>

              {/* 二维码区域 */}
              <div
                className="mb-5 flex h-52 w-52 items-center justify-center rounded-xl border-2 border-dashed"
                style={{ borderColor: wxQrUrl ? "rgba(7,193,96,0.3)" : "rgba(238,238,238,0.4)", background: "rgba(245,243,239,0.5)" }}
              >
                {wxQrUrl ? (
                  <img
                    src={wxQrUrl}
                    alt={t("微信登录二维码")}
                    className="h-44 w-44 rounded-lg"
                  />
                ) : wxStatus === "success" ? (
                  <div className="flex flex-col items-center gap-2">
                    <Check className="h-12 w-12" style={{ color: "#07C160" }} />
                    <span className="text-sm font-medium" style={{ color: "#07C160" }}>{t("接入成功")}</span>
                  </div>
                ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                  <div className="flex flex-col items-center gap-2">
                    <X className="h-12 w-12" style={{ color: "#cf3d4c" }} />
                    <span className="text-xs text-center leading-relaxed" style={{ color: "#cf3d4c" }}>
                      {wxError || t("请重试")}
                    </span>
                  </div>
                ) : (
                  <Loader2 className="h-8 w-8 animate-spin" style={{ color: "#07C160" }} />
                )}
              </div>

              {/* 错误信息 */}
              {wxError && wxStatus !== "failed" && wxStatus !== "expired" && wxStatus !== "timeout" && (
                <p className="mb-3 text-center text-xs font-medium" style={{ color: "#cf3d4c" }}>{wxError}</p>
              )}

              {/* 操作按钮 */}
              {wxStatus === "success" ? (
                <button onClick={closeQrModal} className="lw-btn-primary w-full">
                  <Check className="h-4 w-4" /> {t("完成")}
                </button>
              ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                <div className="flex w-full gap-3">
                  <button onClick={closeQrModal} className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                    {t("关闭")}
                  </button>
                  <button onClick={() => void handleWechatAuth()} className="lw-btn-primary flex-1">
                    {t("重试")}
                  </button>
                </div>
              ) : (
                <button onClick={closeQrModal} className="w-full rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                  {t("取消")}
                </button>
              )}
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}

      <div className="space-y-4">
        {/* Connected channels */}
        {connectedChannels.length > 0 && (
          <div className="space-y-2">
            {connectedChannels.includes("wechat") && (
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(7,193,96,0.2)", background: "rgba(7,193,96,0.04)" }}>
                <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-5 w-5 object-contain" />
                <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>微信</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(7,193,96,0.1)", color: "#07C160" }}>
                  <Check className="h-3 w-3" /> {t("已接入")}
                </span>
              </div>
            )}
            {connectedChannels.includes("qq") && (
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(18,183,245,0.2)", background: "rgba(18,183,245,0.04)" }}>
                <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-5 w-5 object-contain" />
                <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>QQ</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(18,183,245,0.1)", color: "#12B7F5" }}>
                  <Check className="h-3 w-3" /> 已接入
                </span>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="lw-label block">选择要配置的 Hermes Agent</label>
          <select
            value={selectedBotId}
            onChange={(event) => setSelectedBotId(event.target.value)}
            className="lw-input"
            disabled={!configurableBots.length || submitting}
          >
            {configurableBots.length ? configurableBots.map((bot) => (
              <option key={bot.id} value={bot.id}>{bot.name}</option>
            )) : <option value="">暂无可配置 Hermes Agent</option>}
          </select>
        </div>

        {/* Channel selection */}
        <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: 25 }}>选择一个聊天软件接入你的 Hermes Agent</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* QQ */}
          <button
            onClick={() => setSelectedChannel(selectedChannel === "qq" ? null : "qq")}
            disabled={!selectedBot || connectedChannels.includes("qq")}
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-2.5 p-5 text-center transition-all",
              selectedChannel === "qq" && "lw-setup-card--active",
              connectedChannels.includes("qq") && "pointer-events-none opacity-50",
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(18,183,245,0.08)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-8 w-8 object-contain" />
            </div>
            <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>QQ</h4>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">通过QQ机器人与 Hermes Agent 对话</p>
            {selectedChannel === "qq" && (
              <div className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-[var(--shadow-soft)]" style={{ background: "var(--lw-accent)" }}>
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
          </button>

          {/* WeChat */}
          <button
            onClick={() => setSelectedChannel(selectedChannel === "wechat" ? null : "wechat")}
            disabled={!selectedBot || connectedChannels.includes("wechat")}
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-2.5 p-5 text-center transition-all",
              selectedChannel === "wechat" && "lw-setup-card--active",
              connectedChannels.includes("wechat") && "pointer-events-none opacity-50",
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.08)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-8 w-8 object-contain" />
            </div>
            <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>微信</h4>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">扫码登录微信个人号接入</p>
            {selectedChannel === "wechat" && (
              <div className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-[var(--shadow-soft)]" style={{ background: "#07C160" }}>
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
          </button>
        </div>

        {/* WeChat action */}
        <AnimatePresence mode="wait">
          {selectedChannel === "wechat" && (
            <motion.div
              key="wechat-action"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden text-center"
            >
              <button
                onClick={() => void handleWechatAuth()}
                disabled={submitting || !selectedBot}
                className="lw-btn-primary disabled:opacity-60"
                style={{ background: "#07C160", borderColor: "#07C160" }}
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> 授权中...</>
                ) : (
                  <><ScanLine className="h-4 w-4" /> 扫码接入微信</>
                )}
              </button>
            </motion.div>
          )}

          {selectedChannel === "qq" && (
            <motion.div
              key="qq-action"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-3 overflow-hidden"
            >
              <div>
                <label className="lw-label mb-1.5 block">QQ机器人的App ID</label>
                <input
                  type="text"
                  value={qqAppId}
                  onChange={(e) => setQqAppId(e.target.value)}
                  placeholder="请输入 App ID"
                  className="lw-input"
                />
              </div>
              <div>
                <label className="lw-label mb-1.5 block">QQ机器人的App Secret</label>
                <input
                  type="password"
                  value={qqAppSecret}
                  onChange={(e) => setQqAppSecret(e.target.value)}
                  placeholder="请输入 App Secret"
                  className="lw-input"
                />
              </div>
              <button
                onClick={() => void handleQqSubmit()}
                disabled={submitting || !selectedBot || !qqAppId.trim() || !qqAppSecret.trim()}
                className="lw-btn-primary w-full disabled:opacity-60"
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> 配置中...</>
                ) : (
                  <>保存并应用 <ArrowRight className="h-4 w-4" /></>
                )}
              </button>
              <div className="pt-1 text-center">
                <a
                  href="https://q.qq.com/qqbot/openclaw/login.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lw-back-link"
                >
                  查看详情 <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {channelNotice ? (
          <p className="text-sm text-[var(--text-secondary)]">{channelNotice}</p>
        ) : null}
      </div>
    </>
  );
};

/* ─── Skill Section ─── */

const SkillSection = () => {
  const t = useT();
  const personas = useMemo(() => makePersonas(), []);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [installed, setInstalled] = useState(false);

  const handleInstall = useCallback(() => {
    setInstalling(true);
    setProgress(0);
  }, []);

  useEffect(() => {
    if (!installing) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = prev + Math.random() * 3 + 1;
        if (next >= 100) {
          clearInterval(interval);
          setInstalling(false);
          setInstalled(true);
          return 100;
        }
        return next;
      });
    }, 120);

    return () => clearInterval(interval);
  }, [installing]);

  return (
    <div className="space-y-4">
      {installed && selectedPersona ? (
        /* Installed state */
        <div>
          <div className="mb-4 flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(230,111,98,0.2)", background: "rgba(230,111,98,0.04)" }}>
            <span className="text-xl">{selectedPersona.icon}</span>
            <div className="flex-1">
              <span className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{selectedPersona.name} {selectedPersona.nameEn}</span>
              <p className="text-xs text-[var(--text-secondary)]">{selectedPersona.desc}</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(230,111,98,0.08)", color: "var(--lw-accent)" }}>
              <Check className="h-3 w-3" /> {t("已安装")}
            </span>
          </div>
          <div className="space-y-2">
            {selectedPersona.skills.map((skill, idx) => (
              <div key={idx} className="flex items-start gap-3 rounded-xl px-4 py-3" style={{ background: "rgba(245,243,239,0.5)" }}>
                <div className="lw-setup-icon-container flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg">
                  {skill.icon}
                </div>
                <div>
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{skill.name}</h4>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{skill.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setInstalled(false); setSelectedPersona(null); setProgress(0); }}
            className="lw-back-link mt-3"
          >
            {t("重新选择技能包")}
          </button>
        </div>
      ) : installing && selectedPersona ? (
        /* Installing state */
        <div className="text-center">
          <div className="mx-auto mb-4 text-3xl">{selectedPersona.icon}</div>
          <p className="mb-4 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>
            {t("正在安装 {{name}} {{nameEn}}...", { name: selectedPersona.name, nameEn: selectedPersona.nameEn })}
          </p>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold" style={{ color: "var(--lw-fg)" }}>{t("安装进度")}</span>
            <span className="text-xs font-bold" style={{ color: "var(--lw-accent)" }}>{Math.round(progress)}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "#eee" }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: "linear-gradient(90deg, var(--lw-accent), #f0a878)" }}
              initial={{ width: "0%" }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3, ease: "linear" }}
            />
          </div>
        </div>
      ) : (
        /* Selection state */
        <>
          <p className="text-sm text-[var(--text-secondary)]">{t("选择一个技能包，让你的龙虾技能增强")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {personas.map((persona) => (
              <button
                key={persona.id}
                onClick={() => setSelectedPersona(persona)}
                className={cn(
                  "lw-setup-card group flex flex-col items-center gap-2.5 p-5 text-center",
                  selectedPersona?.id === persona.id && "lw-setup-card--active",
                )}
              >
                <div className="lw-setup-icon-container flex h-12 w-12 items-center justify-center rounded-xl text-xl">
                  {persona.icon}
                </div>
                <div>
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>
                    {persona.name} <span className="font-normal text-[var(--text-tertiary)]">{persona.nameEn}</span>
                  </h4>
                </div>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{persona.desc}</p>
              </button>
            ))}
          </div>

          {/* Selected persona skills preview + install */}
          <AnimatePresence mode="wait">
            {selectedPersona && (
              <motion.div
                key={selectedPersona.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="space-y-2 rounded-xl p-4" style={{ background: "rgba(245,243,239,0.5)" }}>
                  <p className="mb-3 text-xs font-bold text-[var(--text-tertiary)]">{t("预装 Agent Skills")}</p>
                  {selectedPersona.skills.map((skill, idx) => (
                    <div key={idx} className="flex items-start gap-3">
                      <div className="lw-setup-icon-container flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg">
                        {skill.icon}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{skill.name}</h4>
                        <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{skill.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 text-center">
                  <button onClick={handleInstall} className="lw-btn-primary">
                    {t("开始安装")} <Sparkles className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
};

void SkillSection;

/* ─── Bot Card for multi-bot display ─── */

// 实例名称展示最多 20 个 Unicode 码点，超出截断并拼接省略号，由调用方配合 title 属性展示全名
const BOT_NAME_DISPLAY_MAX = 20;
const truncateBotName = (name: string) => {
  const chars = Array.from(name);
  return chars.length > BOT_NAME_DISPLAY_MAX ? chars.slice(0, BOT_NAME_DISPLAY_MAX).join("") + "…" : name;
};

// 随机头像列表
const LIGHTCLAW_AVATARS = [assetUrl('/hermes_logo.png')];

// 根据 bot id 获取固定的随机头像（保证同一个 bot 每次显示同一张图）
const getAvatarForBot = (botId: string) => {
  let hash = 0;
  for (let i = 0; i < botId.length; i++) {
    hash = ((hash << 5) - hash) + botId.charCodeAt(i);
    hash |= 0;
  }
  return LIGHTCLAW_AVATARS[Math.abs(hash) % LIGHTCLAW_AVATARS.length];
};

// 出生证明弹窗组件 - 使用 Portal 渲染到 body
const BirthCertificateModal = ({
  bot,
  onClose
}: {
  bot: { id: string; name: string; createdAt: string };
  onClose: () => void;
}) => {
  const t = useT();
  const repositories = useRepositories();
  const certificateRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [bornCardLoading, setBornCardLoading] = useState(true);
  const [bornCardError, setBornCardError] = useState<string | null>(null);
  const [bornCardOrder, setBornCardOrder] = useState<number | null>(null);
  const [bornCardCreatedAt, setBornCardCreatedAt] = useState(bot.createdAt);

  useEffect(() => {
    let cancelled = false;

    setBornCardLoading(true);
    setBornCardError(null);

    repositories.bots.getBotBornCard(bot.id)
      .then((card) => {
        if (cancelled) {
          return;
        }
        setBornCardOrder(card.bornNumberForChina);
        setBornCardCreatedAt(card.createdAt);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : t("出生证明加载失败");
        setBornCardError(message);
        setBornCardOrder(null);
        setBornCardCreatedAt(bot.createdAt);
      })
      .finally(() => {
        if (!cancelled) {
          setBornCardLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bot.createdAt, bot.id, repositories.bots]);

  // 解析创建日期
  const createdDate = new Date(bornCardCreatedAt);
  const year = createdDate.getFullYear();
  const month = createdDate.getMonth() + 1;
  const day = createdDate.getDate();

  // 获取龙虾头像的绝对 URL
  const avatarPath = getAvatarForBot(bot.id) ?? assetUrl('/hermes_logo.png');
  const avatarUrl = avatarImageUrl(avatarPath);

  // 下载图片功能
  const handleDownload = async () => {
    if (!certificateRef.current || downloading) return;

    setDownloading(true);
    try {
      // 动态导入 html2canvas
      const html2canvas = (await import("html2canvas")).default;

      const canvas = await html2canvas(certificateRef.current, {
        backgroundColor: "#FFD4A8",
        scale: 2, // 高清导出
        useCORS: true,
        allowTaint: true,
        logging: false,
        imageTimeout: 15000,
        onclone: (clonedDoc: Document) => {
          // 确保克隆的文档中图片能正确加载
          const clonedElement = clonedDoc.querySelector('[data-certificate]');
          if (clonedElement) {
            (clonedElement as HTMLElement).style.transform = 'none';
          }
        }
      });

      // 创建下载链接
      const link = document.createElement("a");
      link.download = `龙虾出生证明_${bot.name}_${year}${month}${day}.png`;
      link.href = canvas.toDataURL("image/png", 1.0);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("下载失败:", error);
    } finally {
      setDownloading(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
          className="relative flex flex-col items-center"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 证书主体 - 可导出部分 */}
          <div
            ref={certificateRef}
            data-certificate="true"
            style={{
              width: 600,
              backgroundColor: "#FFD4A8",
              backgroundImage: "linear-gradient(145deg, #FFD4A8 0%, #FFCA94 15%, #FFE4C8 50%, #FFCA94 85%, #FFD4A8 100%)",
              borderRadius: 12,
              position: "relative",
              overflow: "hidden",
              boxShadow: "0 25px 60px rgba(0,0,0,0.25), 0 10px 20px rgba(0,0,0,0.15)"
            }}
          >
            {/* 装饰波浪线 - 使用内联 SVG 确保渲染 */}
            <div style={{ position: "absolute", top: 20, left: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", top: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", bottom: 20, left: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", bottom: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ padding: "32px 40px 28px" }}>
              {/* 标题 - 带装饰引号 */}
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <h2
                  style={{
                    fontSize: 36,
                    fontWeight: 900,
                    letterSpacing: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    color: "#E66F62",
                    textShadow: "2px 2px 0 rgba(230,111,98,0.15), -1px -1px 0 rgba(255,255,255,0.5)",
                    margin: 0,
                    lineHeight: 1.2
                  }}
                >
                  <span style={{ fontSize: 30, color: "#E66F62", opacity: 0.6 }}>『</span>
                  小龙虾出生证明
                  <span style={{ fontSize: 30, color: "#E66F62", opacity: 0.6 }}>』</span>
                </h2>
              </div>

              {/* 主体卡片 */}
              <div
                style={{
                  backgroundColor: "rgba(255,250,245,0.95)",
                  border: "3px solid rgba(230,111,98,0.15)",
                  borderRadius: 12,
                  padding: 24,
                  marginLeft: 12,
                  marginRight: 12
                }}
              >
                <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
                  {/* 左侧龙虾图片 */}
                  <div style={{ flexShrink: 0 }}>
                    <div
                      style={{
                        width: 144,
                        height: 144,
                        overflow: "hidden",
                        borderRadius: 12,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(255,240,230,0.8)"
                      }}
                    >
                      <img
                        src={avatarUrl}
                        alt="Hermes宝宝"
                        style={{
                          width: 128,
                          height: 128,
                          objectFit: "contain"
                        }}
                      />
                    </div>
                  </div>

                  {/* 右侧信息 */}
                  <div style={{ flex: 1, paddingTop: 8 }}>
                    {/* 龙虾姓名 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        龙虾姓名
                      </span>
                      <div
                        style={{
                          flex: 1,
                          borderBottom: "2px solid rgba(92,64,51,0.25)",
                          paddingBottom: 4,
                          minWidth: 0
                        }}
                      >
                        <span
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            display: "block",
                            color: "#3D2B1F",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                          }}
                        >
                          {bot.name}
                        </span>
                      </div>
                    </div>

                    {/* 家庭住址 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        家庭住址：
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: "#5C4033"
                        }}
                      >
                        LightVela
                      </span>
                    </div>

                    {/* 出生日期 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        出生日期：
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: "#5C4033"
                        }}
                      >
                        {year}年{month}月{day}日
                      </span>
                    </div>
                  </div>
                </div>

                {/* 底部印章徽章 */}
                <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                  {bornCardLoading ? (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        paddingLeft: 24,
                        paddingRight: 24,
                        paddingTop: 12,
                        paddingBottom: 12,
                        borderRadius: 9999,
                        backgroundColor: "rgba(255,245,238,0.9)",
                        border: "2px solid rgba(230,111,98,0.2)",
                        color: "#E66F62",
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      出生编号加载中...
                    </div>
                  ) : bornCardError ? (
                    <div
                      style={{
                        maxWidth: 360,
                        padding: "12px 18px",
                        borderRadius: 16,
                        backgroundColor: "rgba(255,245,238,0.95)",
                        border: "2px solid rgba(230,111,98,0.2)",
                        color: "#A14E45",
                        fontSize: 14,
                        fontWeight: 600,
                        textAlign: "center",
                      }}
                    >
                      出生编号暂时不可用，请稍后重试。
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        paddingLeft: 24,
                        paddingRight: 24,
                        paddingTop: 12,
                        paddingBottom: 12,
                        borderRadius: 9999,
                        backgroundColor: "rgba(255,245,238,0.9)",
                        border: "2px solid rgba(230,111,98,0.25)"
                      }}
                    >
                      <span style={{ fontSize: 14, marginRight: 4, color: "#E66F62" }}>✦</span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: "#E66F62"
                        }}
                      >
                        今天出生的第
                      </span>
                      <span
                        style={{
                          fontSize: 30,
                          fontWeight: 900,
                          marginLeft: 4,
                          marginRight: 4,
                          color: "#E66F62",
                          textShadow: "1px 1px 0 rgba(230,111,98,0.2)"
                        }}
                      >
                        {bornCardOrder}
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: "#E66F62"
                        }}
                      >
                        个Hermes宝宝
                      </span>
                      <span style={{ fontSize: 14, marginLeft: 4, color: "#E66F62" }}>✦</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 操作按钮区域 - 证书外部 */}
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={handleDownload}
              disabled={downloading || bornCardLoading || !!bornCardError}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
              style={{ background: "#E66F62" }}
            >
              {downloading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  下载中...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  下载图片
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold transition-all hover:bg-[rgba(255,255,255,0.15)]"
              style={{ color: "#fff", background: "rgba(255,255,255,0.1)" }}
            >
              <X className="h-4 w-4" />
              关闭
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

/* ─── Channel Modal (per bot) ─── */

const ChannelModal = ({ bot, onClose }: { bot: { id: string; name: string; connectedChannels: string[] }; onClose: () => void }) => {
  const repositories = useRepositories();
  const { updateBot } = useOpenClaw();
  const [selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [qqAccount, setQqAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);

  /* ── WeChat login session state ── */
  const [showQrModal, setShowQrModal] = useState(false);
  const [wxSessionId, setWxSessionId] = useState("");
  const [wxStatus, setWxStatus] = useState<WeixinSessionStatus>("idle");
  const [wxQrUrl, setWxQrUrl] = useState("");
  const [wxError, setWxError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const connectedChannels: ConnectedChannel[] = (bot.connectedChannels ?? []) as ConnectedChannel[];

  /* ── 关闭弹窗 → 停止一切 ── */
  const closeQrModal = useCallback(() => {
    cancelledRef.current = true;
    const sid = wxSessionId;
    if (sid && wxStatus !== "success" && wxStatus !== "cancelled" && wxStatus !== "failed") {
      void repositories.bots.cancelWeixinLoginSession(bot.id, sid).catch(() => { });
    }
    setShowQrModal(false);
    setWxSessionId("");
    setWxStatus("idle");
    setWxQrUrl("");
    setWxError(null);
  }, [wxSessionId, wxStatus, repositories.bots, bot.id]);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  /* ── 轮询获取 session 状态（SSE 降级 & 实例未就绪等待） ── */
  const pollSession = useCallback(async (botId: string, sessionId: string): Promise<void> => {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      if (cancelledRef.current) return;
      try {
        const snapshot = await repositories.bots.getWeixinLoginSession(botId, sessionId);
        console.log(`[WX-DEBUG] 轮询 #${i}:`, JSON.stringify(snapshot));
        if (cancelledRef.current) return;
        const status = (snapshot.status ?? "") as WeixinSessionStatus;
        if (snapshot.qr_url) setWxQrUrl(snapshot.qr_url);
        if (status) setWxStatus(status);
        if (snapshot.error_message) setWxError(snapshot.error_message);
        if (status === "success") {
          trackDatongEvent(DATONG_EVENTS.CHANNEL_CONNECT_SUCCESS, {
            pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
            params: { bot_id: botId, channel_type: "wechat" },
          });
          const next: ConnectedChannel[] = connectedChannels.includes("wechat") ? connectedChannels : [...connectedChannels, "wechat"];
          updateBot(botId, { connectedChannels: next });
          return;
        }
        if (["failed", "expired", "cancelled", "timeout"].includes(status)) return;
      } catch {
        /* 轮询失败时静默重试 */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }, [repositories.bots, connectedChannels, updateBot]);

  /* ── 启动微信扫码流程 ── */
  const handleWechatAuth = useCallback(async () => {
    cancelledRef.current = false;
    trackDatongClick("channel_connect_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
      params: { bot_id: bot.id, channel_type: "wechat" },
    });
    setShowQrModal(true);
    setWxStatus("creating");
    setWxQrUrl("");
    setWxError(null);
    setWxSessionId("");

    /* 步骤 1: 创建 weixin login session（如果实例未就绪，轮询重试） */
    let sessionId = "";
    const maxCreateRetries = 40;
    for (let attempt = 0; attempt < maxCreateRetries; attempt++) {
      if (cancelledRef.current) return;
      try {
        const result = await repositories.bots.createWeixinLoginSession(bot.id);
        sessionId = result.sessionId;
        break;
      } catch (err) {
        if (cancelledRef.current) return;
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : "";

        /* 已有活跃 session → 提取 sessionId，取消后重试 */
        if (code === "CHANNEL_LOGIN_CONFLICT" || (status === 409 && msg.includes("active session already exists"))) {
          console.log("[WX-DEBUG] 检测到已有活跃 session，尝试取消...", msg);
          const existingId = msg.match(/active session already exists:\s*([\w-]+)/)?.[1] ?? "";
          if (existingId) {
            try {
              await repositories.bots.cancelWeixinLoginSession(bot.id, existingId);
              console.log("[WX-DEBUG] 已取消旧 session:", existingId);
            } catch (cancelErr) {
              console.warn("[WX-DEBUG] 取消旧 session 失败:", cancelErr);
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        /* 实例未就绪（如 DEBUG_NOT_SUPPORTED）→ 等待重试 */
        if (status === 409 || code === "DEBUG_NOT_SUPPORTED") {
          setWxStatus("creating");
          setWxError(null);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        setWxStatus("failed");
        setWxError(msg || "微信登录会话创建失败");
        return;
      }
    }

    if (!sessionId || cancelledRef.current) return;
    console.log("[WX-DEBUG] sessionId 创建成功:", sessionId);
    setWxSessionId(sessionId);
    setWxStatus("starting");

    /* 步骤 2: 尝试 SSE 订阅 */
    const abortController = new AbortController();
    const onCancelCleanup = () => { abortController.abort(); };
    /* 当 cancelledRef 变 true 时 abort SSE（通过 closeQrModal） */

    let sseWorked = false;
    try {
      console.log("[WX-DEBUG] 开始 SSE 订阅...");
      const events = repositories.bots.subscribeWeixinLoginSessionEvents(bot.id, sessionId, abortController.signal);
      for await (const { event, data } of events) {
        if (cancelledRef.current) { onCancelCleanup(); return; }
        sseWorked = true;
        console.log("[WX-DEBUG] SSE 收到事件:", event, JSON.stringify(data));

        const payload = data as {
          status?: string; qr_url?: string; error_message?: string; error?: string;
          data?: { status?: string; qr_url?: string; error_message?: string };
        };
        const resolved = payload.data ?? payload;
        const newStatus = (resolved.status ?? "") as WeixinSessionStatus;
        const qrUrl = resolved.qr_url ?? "";
        const errorMsg = resolved.error_message ?? payload.error ?? "";

        if (qrUrl) setWxQrUrl(qrUrl);
        if (newStatus) setWxStatus(newStatus);
        if (errorMsg && (newStatus === "failed" || event === "error")) setWxError(errorMsg);

        if (newStatus === "success") {
          const next: ConnectedChannel[] = connectedChannels.includes("wechat") ? connectedChannels : [...connectedChannels, "wechat"];
          updateBot(bot.id, { connectedChannels: next });
          return;
        }
        if (["failed", "expired", "cancelled", "timeout"].includes(newStatus) || event === "finished" || event === "error") return;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.warn("[WX-DEBUG] SSE 连接失败，降级轮询:", err);
      /* SSE 连接失败 → 降级轮询 */
    }

    /* 步骤 3: 如果 SSE 没有工作或过早断开，降级到轮询 */
    console.log("[WX-DEBUG] SSE 结束, sseWorked:", sseWorked, "cancelled:", cancelledRef.current);
    if (!sseWorked && !cancelledRef.current) {
      console.log("[WX-DEBUG] 降级到轮询模式...");
      await pollSession(bot.id, sessionId);
    }
  }, [bot.id, connectedChannels, repositories.bots, updateBot, pollSession]);

  const handleQqSubmit = async () => {
    if (!qqAppId.trim() || !qqAppSecret.trim()) return;
    trackDatongClick("channel_connect_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
      params: { bot_id: bot.id, channel_type: "qq" },
    });
    setSubmitting(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(bot.id, {
        appId: qqAppId,
        appSecret: qqAppSecret,
        account: qqAccount || undefined,
      });
      trackDatongEvent(DATONG_EVENTS.CHANNEL_CONNECT_SUCCESS, {
        pgid: DATONG_PAGE_IDS.AGENT_CHANNELS,
        params: { bot_id: bot.id, channel_type: "qq" },
      });
      const nextChannels: ConnectedChannel[] = connectedChannels.includes("qq")
        ? connectedChannels
        : [...connectedChannels, "qq"];
      updateBot(bot.id, { connectedChannels: nextChannels });
      setSelectedChannel(null);
      setQqAppId("");
      setQqAppSecret("");
      setQqAccount("");
      setChannelNotice(result.gatewayRestarted ? "QQ channel 已配置，gateway 已重启。" : "QQ channel 已配置，但 gateway 未确认重启。");
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : "QQ channel 配置失败");
    } finally {
      setSubmitting(false);
    }
  };

  const wxStatusLabel: Record<string, { text: string; color: string }> = {
    creating: { text: "正在准备实例，请稍候…", color: "#999" },
    starting: { text: "正在启动微信登录…", color: "#999" },
    waiting_qr: { text: "请使用微信扫描二维码", color: "#07C160" },
    scanned: { text: "已扫码，正在确认登录…", color: "#07C160" },
    success: { text: "微信通道接入成功！", color: "#07C160" },
    failed: { text: "登录失败", color: "#cf3d4c" },
    expired: { text: "二维码已过期", color: "#C67B1E" },
    cancelled: { text: "已取消", color: "#999" },
    timeout: { text: "登录超时", color: "#C67B1E" },
  };

  return createPortal(
    <AnimatePresence>
      {/* WeChat QR sub-modal */}
      {showQrModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
          onClick={closeQrModal}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-2xl border p-8 shadow-2xl"
            style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={closeQrModal} className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--lw-bg-secondary)] text-[var(--text-tertiary)]">
              <X className="h-4 w-4" />
            </button>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.1)" }}>
              {wxStatus === "success" ? <Check className="h-6 w-6" style={{ color: "#07C160" }} /> : <ScanLine className="h-6 w-6" style={{ color: "#07C160" }} />}
            </div>
            <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>微信扫码接入</h3>
            <p className="mb-4 text-center text-sm font-medium" style={{ color: wxStatusLabel[wxStatus]?.color ?? "#999" }}>
              {wxStatusLabel[wxStatus]?.text ?? "准备中…"}
            </p>
            {/* QR 区域 */}
            <div className="mb-5 flex h-52 w-52 items-center justify-center rounded-xl" style={{ background: wxQrUrl ? "#fff" : "rgba(245,243,239,0.5)", border: wxQrUrl ? "none" : "2px dashed rgba(238,238,238,0.4)" }}>
              {wxQrUrl ? (
                <QRCodeSVG value={wxQrUrl} size={192} level="M" includeMargin={false} />
              ) : wxStatus === "success" ? (
                <div className="flex flex-col items-center gap-2">
                  <Check className="h-12 w-12" style={{ color: "#07C160" }} />
                  <span className="text-sm font-medium" style={{ color: "#07C160" }}>接入成功</span>
                </div>
              ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                <div className="flex flex-col items-center gap-2 px-4">
                  <X className="h-12 w-12" style={{ color: "#cf3d4c" }} />
                  <span className="text-xs text-center leading-relaxed" style={{ color: "#cf3d4c" }}>{wxError || "请重试"}</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin" style={{ color: "#07C160" }} />
                  {wxStatus === "creating" && (
                    <span className="text-xs" style={{ color: "#999" }}>等待实例就绪…</span>
                  )}
                </div>
              )}
            </div>
            {/* 错误信息 */}
            {wxError && !["failed", "expired", "timeout"].includes(wxStatus) && (
              <p className="mb-3 text-center text-xs font-medium" style={{ color: "#cf3d4c" }}>{wxError}</p>
            )}
            {/* 操作按钮 */}
            {wxStatus === "success" ? (
              <button onClick={closeQrModal} className="w-full rounded-lg py-2.5 text-sm font-bold text-white" style={{ background: "#07C160", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                <Check className="h-4 w-4" /> 完成
              </button>
            ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
              <div className="flex w-full gap-3">
                <button onClick={closeQrModal} className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>关闭</button>
                <button onClick={() => void handleWechatAuth()} className="flex-1 rounded-lg py-2.5 text-sm font-bold text-white" style={{ background: "#07C160" }}>重试</button>
              </div>
            ) : (
              <button onClick={closeQrModal} className="w-full rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>取消</button>
            )}
          </motion.div>
        </motion.div>
      )}

      {/* Main Channel Modal */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="relative mx-4 flex w-full max-w-lg flex-col rounded-2xl border shadow-2xl"
          style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header — 无分割线 */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <div className="flex items-center gap-2.5">
              <MessageCircle className="h-4 w-4" style={{ color: "var(--lw-accent)" }} />
              <h3 className="text-base font-bold" style={{ color: "var(--lw-fg)" }}>接入通道 · {bot.name}</h3>
            </div>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="space-y-4 p-6">
            {/* Connected channels */}
            {connectedChannels.length > 0 && (
              <div className="space-y-2">
                {connectedChannels.includes("wechat") && (
                  <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(7,193,96,0.2)", background: "rgba(7,193,96,0.04)" }}>
                    <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-5 w-5 object-contain" />
                    <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>微信</span>
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(7,193,96,0.1)", color: "#07C160" }}>
                      <Check className="h-3 w-3" /> 已接入
                    </span>
                  </div>
                )}
                {connectedChannels.includes("qq") && (
                  <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(18,183,245,0.2)", background: "rgba(18,183,245,0.04)" }}>
                    <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-5 w-5 object-contain" />
                    <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>QQ</span>
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(18,183,245,0.1)", color: "#12B7F5" }}>
                      <Check className="h-3 w-3" /> 已接入
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Channel selection */}
            <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: "20px" }}>选择一个聊天软件接入你的 Hermes Agent</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              {/* QQ */}
              <button
                onClick={() => setSelectedChannel(selectedChannel === "qq" ? null : "qq")}
                disabled={connectedChannels.includes("qq")}
                className={cn(
                  "lw-setup-card group relative flex flex-col items-center justify-center gap-2.5 px-4 text-center transition-all overflow-visible",
                  selectedChannel === "qq" && "lw-setup-card--active",
                  connectedChannels.includes("qq") && "pointer-events-none opacity-50",
                )}
                style={{ height: "120px" }}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(18,183,245,0.08)" }}>
                  <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-7 w-7 object-contain" />
                </div>
                <div className="text-center">
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>QQ</h4>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">通过 QQ 机器人对话</p>
                </div>
                {selectedChannel === "qq" && (
                  <div className="absolute flex items-center justify-center rounded-full" style={{ top: "8px", right: "8px", width: "20px", height: "20px", background: "var(--lw-accent)" }}>
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>

              {/* WeChat — 扫码接入 */}
              <button
                onClick={() => setSelectedChannel(selectedChannel === "wechat" ? null : "wechat")}
                disabled={connectedChannels.includes("wechat")}
                className={cn(
                  "lw-setup-card group relative flex flex-col items-center justify-center gap-2.5 px-4 text-center transition-all overflow-visible",
                  selectedChannel === "wechat" && "lw-setup-card--active",
                  connectedChannels.includes("wechat") && "pointer-events-none opacity-50",
                )}
                style={{ height: "120px" }}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(7,193,96,0.08)" }}>
                  <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-7 w-7 object-contain" />
                </div>
                <div className="text-center">
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>微信</h4>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">扫码登录微信个人号</p>
                </div>
                {selectedChannel === "wechat" && (
                  <div className="absolute flex items-center justify-center rounded-full" style={{ top: "8px", right: "8px", width: "20px", height: "20px", background: "#07C160" }}>
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>
            </div>

            {/* Channel action panels */}
            <AnimatePresence mode="wait">
              {selectedChannel === "wechat" && (
                <motion.div key="wechat-action" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden text-center">
                  <button
                    onClick={() => void handleWechatAuth()}
                    disabled={submitting}
                    className="w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                    style={{ background: "#07C160", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> 授权中...</>) : (<><ScanLine className="h-4 w-4" /> 扫码接入微信</>)}
                  </button>
                </motion.div>
              )}
              {selectedChannel === "qq" && (
                <motion.div key="qq-action" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-3" style={{ overflow: "visible" }}>
                  <div className="px-0.5">
                    <label className="lw-label mb-1.5 block">QQ 机器人 App ID</label>
                    <input type="text" value={qqAppId} onChange={(e) => setQqAppId(e.target.value)} placeholder="请输入 App ID" className="lw-input" />
                  </div>
                  <div className="px-0.5">
                    <label className="lw-label mb-1.5 block">QQ 机器人 App Secret</label>
                    <input type="password" value={qqAppSecret} onChange={(e) => setQqAppSecret(e.target.value)} placeholder="请输入 App Secret" className="lw-input" />
                  </div>
                  <button onClick={() => void handleQqSubmit()} disabled={submitting || !qqAppId.trim() || !qqAppSecret.trim()} className="w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50" style={{ background: "#E8503A", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                    {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> 配置中...</>) : (<>保存并应用 <ArrowRight className="h-4 w-4" /></>)}
                  </button>
                  <div className="pt-1 text-center">
                    <a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" rel="noopener noreferrer" className="lw-back-link">
                      查看详情 <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {channelNotice && <p className="text-sm text-[var(--text-secondary)]">{channelNotice}</p>}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

export const _BotInfoCard = ({ bot, index, onDelete, onTerminal }: { bot: { id: string; name: string; personality: string; personalityEmoji: string; intro: string; status: string; connectedChannels: string[]; installedSkills: string[]; createdAt: string }; index: number; onDelete: (id: string) => void; onTerminal: (id: string) => void }) => {
  void onDelete;
  void onTerminal;
  const [showBirthCert, setShowBirthCert] = useState(false);
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const { deleteBot } = useOpenClaw();
  const t = useT();

  // 国内站封存组件：所有 hooks 调用完毕后再做国际站短路（遵循 React Hooks 调用顺序规则）
  if (isGlobal) return null;

  // 获取该 bot 的固定头像
  const avatarUrl = getAvatarForBot(bot.id);
  const connectedChannels = bot.connectedChannels ?? [];

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
        transition={{ delay: index * 0.08 }}
        className="overflow-hidden"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}
      >
        {/* 平铺列表行：avatar + info + actions */}
        <div className="flex items-center gap-4 py-4 px-1">
          {/* Avatar */}
          <div
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
            style={{ background: "rgba(0,0,0,0.03)" }}
          >
            <img src={avatarUrl} alt="" className="h-9 w-9 object-contain" />
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h4 className="truncate text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{bot.name}</h4>
              <button
                onClick={() => setShowBirthCert(true)}
                className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium transition-all hover:opacity-70"
                style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)", cursor: "pointer", border: "none" }}
              >
                📜 出生证明
              </button>
              {/* Tags: connected channels + skills */}
              {connectedChannels.map((ch) => (
                <span key={ch} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: ch === "wechat" ? "rgba(7,193,96,0.08)" : "rgba(18,183,245,0.08)", color: ch === "wechat" ? "#07C160" : "#12B7F5" }}>
                  <Check className="h-3 w-3" /> {ch === "wechat" ? "微信" : "QQ"}
                </span>
              ))}
              {bot.installedSkills.length > 0 && bot.installedSkills.map((sk) => (
                <span key={sk} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)" }}>
                  <Sparkles className="h-3 w-3" /> {sk}
                </span>
              ))}
            </div>

            {/* 简介（为空时不展示） */}
            {bot.intro && (
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "#999" }}>
                {bot.intro}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              onClick={() => setShowChannelModal(true)}
              className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition-all hover:opacity-80"
              style={{ background: "rgba(230,111,98,0.08)", color: "var(--lw-accent)" }}
            >
              <MessageCircle className="h-3 w-3" />
              {connectedChannels.length > 0 ? `${connectedChannels.length} 通道` : "接入通道"}
            </button>
            <button
              onClick={() => { setDeleteInput(""); setShowDeleteConfirm(true); }}
              className="flex h-7 w-7 items-center justify-center rounded-lg transition-all hover:bg-[rgba(220,38,38,0.08)]"
              style={{ color: "#ccc" }}
              title="删除"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </motion.div>

      {/* 出生证明弹窗 */}
      {showBirthCert && (
        <BirthCertificateModal bot={bot} onClose={() => setShowBirthCert(false)} />
      )}

      {/* 接入通道弹窗 */}
      {showChannelModal && (
        <ChannelModal bot={bot} onClose={() => setShowChannelModal(false)} />
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div className="mx-4 w-full max-w-[26.4rem] rounded-2xl border bg-white p-6 shadow-2xl" style={{ borderColor: "rgba(238,238,238,0.4)" }} onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("删除智能体")}</h3>
            </div>
            {/* 风险说明 */}
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "12px" }}>
              {t("删除后会话将立即断开，数据将无法恢复。请谨慎操作！")}
            </p>
            {/* 操作引导 */}
            <p style={{ color: "var(--lw-fg)", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              {t("如确认删除，请输入名称")}{" "}
              <span className="select-all rounded-md bg-red-50 px-1.5 py-0.5 font-semibold text-red-600">
                {bot.name}
              </span>
            </p>
            <input type="text" placeholder={t("请输入 {{name}}", { name: bot.name })} value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]" style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }} />
            {deleteErr && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteErr}</p>}
            {/* 按钮组：上下排列 */}
            <div className="flex flex-col gap-2">
              <button onClick={async () => { setDeleting(true); setDeleteErr(null); try { await deleteBot(bot.id); setShowDeleteConfirm(false); } catch (e) { setDeleteErr(e instanceof Error ? e.message : t("删除失败")); } finally { setDeleting(false); } }} disabled={deleteInput !== bot.name || deleting} className="w-full rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all" style={{ backgroundColor: deleteInput === bot.name && !deleting ? "#DC2626" : "#E5E7EB", cursor: deleteInput === bot.name && !deleting ? "pointer" : "not-allowed", fontSize: "16px" }}>
                {deleting ? t("删除中...") : t("确认删除")}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="py-2 text-[16px] transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer", fontSize: "16px" }}>
                {t("取消")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

/* ─── Creating Loading Animation ─── */

const CREATING_POLL_INTERVAL_MS = 3000;
const CREATING_MAX_WAIT_MS = 15 * 60 * 1000;

const CreatingLoadingView = ({ errorMessage }: { errorMessage?: string | null }) => {
  const t = useT();
  /* 动态 "..." 计数：0 -> 1 -> 2 -> 3 -> 0 ... 每 450ms 切换 */
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 450);
    return () => clearInterval(interval);
  }, []);

  const dots = ".".repeat(dotCount);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center justify-center py-20"
    >
      {/* Hermes 咖啡杯 —— 对应 Figma 231:4742 中心图（从 2x2 sprite 中裁剪左上角） */}
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="mb-2"
      >
        <div
          className="h-[78px] w-[78px] overflow-hidden"
          style={{
            backgroundImage: `url(${assetUrl("/hermes-loading.png")})`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "0 0",
            backgroundSize: "156px 156px",
          }}
        />
      </motion.div>

      {/* 文案：单行 + 动态省略号 */}
      <p
        className="text-center"
        style={{
          fontFamily: "PingFang SC, -apple-system, BlinkMacSystemFont, sans-serif",
          fontWeight: 500,
          fontSize: 14,
          lineHeight: "2em",
          color: "rgba(0,0,0,0.9)",
        }}
      >
        {errorMessage ? (
          errorMessage
        ) : (
          <>
            {t("正在给 Hermes Agent 喂咖啡，唤醒大脑中")}
            <span className="inline-block" style={{ width: "1.5em", textAlign: "left" }}>
              {dots}
            </span>
          </>
        )}
      </p>
    </motion.div>
  );
};

const getBotStatusColor = (status: OpenClawBot["status"]) => {
  if (status === "running") return "#34C759";
  if (status === "paused") return "#FF9500";
  if (status === "failed") return "#DC2626";
  return "#999";
};

const getBotStatusLabel = (status: OpenClawBot["status"]) => {
  if (status === "running") return rawT("运行中");
  if (status === "paused") return rawT("已暂停");
  if (status === "failed") return rawT("创建失败");
  if (status === "deleting") return rawT("删除中");
  if (status === "provisioning") return rawT("创建中");
  return rawT("草稿");
};

/* ─── Main Settings Page ─── */

const RESCUE_EXPORT_POLL_INTERVAL_MS = 5000;
const HERMES_WORKSPACE_EXPORT_PATH = "/home/agentuser/.hermes";
const RESCUE_EXPORT_TERMINAL_PHASES = new Set(["completed", "failed"]);
const TEA_SDK_SECTIONS = new Set<AgentSettingsSectionId>(["channel", "model"]);

type WorkspaceConfirmState =
  | { kind: "export" }
  | { kind: "import"; file: File | null };

const formatWorkspaceImportFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1;
  const unit = units[unitIndex] ?? "GB";
  return `${value.toFixed(fractionDigits)} ${unit}`;
};

function AgentSettingsDataLoading() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]" aria-hidden="true">
      <aside className="lg:sticky lg:top-[84px]">
        <div className="rounded-md border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
          <div className="flex items-center gap-3 rounded-md px-2.5 py-2.5">
            <span className="h-10 w-10 flex-shrink-0 animate-pulse rounded-md bg-black/[0.045]" />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="block h-4 w-28 animate-pulse rounded bg-black/[0.045]" />
              <span className="block h-3 w-16 animate-pulse rounded bg-black/[0.035]" />
            </span>
          </div>
          <span className="mt-3 block h-9 w-full animate-pulse rounded-md bg-black/[0.035]" />
        </div>
        <nav className="mt-4 rounded-md border border-black/[0.06] bg-white p-2 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
          {Array.from({ length: 8 }).map((_, index) => (
            <span key={index} className="flex items-center gap-2.5 rounded-md px-3 py-2.5">
              <span className="h-5 w-5 animate-pulse rounded bg-black/[0.035]" />
              <span className="h-4 w-16 animate-pulse rounded bg-black/[0.035]" />
            </span>
          ))}
        </nav>
      </aside>
      <section className="min-w-0">
        <div className="rounded-md border border-black/[0.06] bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
          <span className="block h-5 w-36 animate-pulse rounded bg-black/[0.045]" />
          <span className="mt-3 block h-4 w-64 max-w-full animate-pulse rounded bg-black/[0.035]" />
          <span className="mt-8 block h-40 w-full animate-pulse rounded-md bg-black/[0.025]" />
        </div>
      </section>
    </div>
  );
}

const isRescueExportRunning = (status: WorkerActionStatusResult | null | undefined) => {
  if (!status) return false;
  return !RESCUE_EXPORT_TERMINAL_PHASES.has(status.phase);
};

export const AgentSettingsPage = ({
  initialSectionSlug,
  sectionId,
  showHeader = true,
}: {
  initialSectionSlug?: string;
  sectionId?: AgentSettingsSectionId;
  showHeader?: boolean;
} = {}) => {
  const t = useT();
  const navigate = useAppNavigate();
  const [searchParams] = useAppSearchParams();
  const creatingParam = searchParams.get("creating")?.trim() ?? "";
  const requestedCreatingBotId = creatingParam && creatingParam !== "true" ? creatingParam : "";
  const { bots, botsLoading, deleteBot, user, refreshBots, refreshPasses, isSubscribed, addBot, activePass } = useOpenClaw();
  const repositories = useRepositories();
  const paidBillingEnabled = usePaidBillingEnabled();
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  const paidBillingActive = isCN && isPaidBillingEnabled(paidBillingEnabled);
  const {
    commandLifecycle: automationModelCommandLifecycle,
    confirmationDialog: automationModelSwitchDialog,
  } = useAutomationAwareModelSwitch();
  const qqbotGroupPolicyCommandLifecycle = useMemo(
    () => createQqbotGroupPolicyCommandLifecycle(),
    [],
  );
  const sdkCommandLifecycle = useMemo(
    () => composeDebugExecCommandLifecycles(
      automationModelCommandLifecycle,
      qqbotGroupPolicyCommandLifecycle,
    ),
    [automationModelCommandLifecycle, qqbotGroupPolicyCommandLifecycle],
  );
  // 账号 id：来自 /auth/profile 下发的 session.user.id，用于 LightVelaPanel.userId 等场景
  const { session } = useSession();
  const accountId = session.user?.id ?? "";
  const renewalRealnameVerified = isRenewalRealnameVerified(session.user, realnamePhoneVerificationEnabled);

  useEffect(() => {
    document.documentElement.classList.add("lw-settings-scrollbar-stable");
    return () => {
      document.documentElement.classList.remove("lw-settings-scrollbar-stable");
    };
  }, []);

  /* 创建 loading 状态 */
  const [isCreating, setIsCreating] = useState(Boolean(creatingParam));
  const [creationError, setCreationError] = useState<string | null>(null);
  /* 已订阅用户直接创建 Agent 的确认弹窗 */
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [directCreating, setDirectCreating] = useState(false);
  const [directCreateError, setDirectCreateError] = useState<string | null>(null);
  const visibleBots = useMemo(
    () => bots.filter((bot) => bot.status !== "provisioning" && bot.status !== "deleting"),
    [bots],
  );
  const createLimitMessage = useMemo(
    () => getOpenClawCreateLimitMessage(bots, user.plan.maxBots),
    [bots, user.plan.maxBots],
  );
  const canCreateBot = createLimitMessage === null;
  const provisioningBot = useMemo(() => {
    if (requestedCreatingBotId) {
      return bots.find((bot) => bot.id === requestedCreatingBotId && bot.status === "provisioning") ?? null;
    }
    return bots.find((bot) => bot.status === "provisioning") ?? null;
  }, [bots, requestedCreatingBotId]);
  const completedCreatingBot = useMemo(
    () => findCompletedCreatingBot(visibleBots, requestedCreatingBotId),
    [visibleBots, requestedCreatingBotId],
  );
  /* 实例内部的子页面切换：由 Next /agents/<section> 路由在服务端校验，client 只接收已归一化 sectionId。 */
  const activeSection = sectionId ?? DEFAULT_AGENT_SECTION;

  useEffect(() => {
    if (!TEA_SDK_SECTIONS.has(activeSection)) return;
    void loadTeaSdkRuntime().catch(() => {
      // The visible settings panel reports the concrete loading error.
    });
  }, [activeSection]);

  /* Tab 切换 */
  const [activeTabId, setActiveTabId] = useState((visibleBots[0]?.id ?? requestedCreatingBotId) || "creating");
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isAgentActionMenuOpen, setIsAgentActionMenuOpen] = useState(false);
  const [renewPassModalOpen, setRenewPassModalOpen] = useState(false);
  const agentActionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isAgentActionMenuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!agentActionMenuRef.current?.contains(event.target as Node)) {
        setIsAgentActionMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsAgentActionMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAgentActionMenuOpen]);

  // bots 异步加载完成后，若当前 tab 无效则自动切换到第一个可展示 bot
  useEffect(() => {
    if (isCreating) return;
    if (visibleBots.length > 0 && !visibleBots.some((b) => b.id === activeTabId)) {
      setActiveTabId(visibleBots[0]!.id);
    }
  }, [visibleBots, activeTabId, isCreating]);
  const activeBot = visibleBots.find((b) => b.id === activeTabId) ?? visibleBots[0];
  const activeBotStatus = activeBot?.status;
  const passExpiryReminder = useMemo(
    () => (paidBillingActive ? getPassExpiryReminder(activePass) : null),
    [activePass, paidBillingActive],
  );
  const passExpiryTooltipId = useId();
  const handleRenewPassSuccess = useCallback(async () => {
    setRenewPassModalOpen(false);
    await refreshPasses();
  }, [refreshPasses]);
  const isInitialBotsLoading = shouldShowAgentSettingsDataLoading({
    botsLoading,
    isCreating,
    visibleBotCount: visibleBots.length,
  });

  /**
   * AgentChat（LightVela）启动 token：
   * - 接口：`POST /v1/instances/:instanceId/agentchat/launch-token`，需带 LightClaw Bearer 登录态
   * - TTL：300 秒；过期前 60 秒自动续期
   * - 仅在用户进入 chat tab 且 activeBot 存在时拉取，避免无意义请求
   * - 401 / 网络错误：状态置为 error，由 chat tab UI 提示并提供重试
   */
  const [launchToken, setLaunchToken] = useState<string | null>(null);
  const [launchTokenStatus, setLaunchTokenStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [launchTokenError, setLaunchTokenError] = useState<string | null>(null);
  const [launchTokenRefreshTick, setLaunchTokenRefreshTick] = useState(0);

  const activeBotId = activeBot?.id;

  useEffect(() => {
    // 仅在 chat tab 激活、activeBot 已就位、用户已登录（拿到账号 id）时拉取
    if (activeSection !== "chat" || !activeBotId) {
      return;
    }
    if (!accountId) {
      setLaunchTokenStatus("error");
      setLaunchTokenError("未登录，无法获取账号 id");
      return;
    }

    const baseUrl = resolveConfiguredAuthApiBaseUrl();
    if (!baseUrl) {
      setLaunchTokenStatus("error");
      setLaunchTokenError(AUTH_SERVICE_UNAVAILABLE_MESSAGE);
      return;
    }

    const authToken = readStoredAuthToken();
    if (!authToken) {
      setLaunchTokenStatus("error");
      setLaunchTokenError("未登录，无法获取 AgentChat 启动 token");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchLaunchToken = async () => {
      setLaunchTokenStatus("loading");
      setLaunchTokenError(null);
      try {
        const url = `${baseUrl.replace(/\/$/, "")}/v1/instances/${encodeURIComponent(activeBotId)}/agentchat/launch-token`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: "{}",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (cancelled) return;
          let detail = `HTTP ${response.status}`;
          try {
            const body = await response.json() as { code?: string; message?: string };
            if (body?.message) detail = `${body.code ?? response.status}: ${body.message}`;
          } catch {
            // 忽略响应体解析错误
          }
          setLaunchTokenStatus("error");
          setLaunchTokenError(detail);
          return;
        }

        const json = await response.json() as {
          code?: string;
          data?: { launch_token?: string; expires_at?: number };
          message?: string;
        };
        if (cancelled) return;

        const token = json?.data?.launch_token;
        const expiresAt = json?.data?.expires_at;
        if (!token) {
          setLaunchTokenStatus("error");
          setLaunchTokenError(json?.message || "返回数据缺少 launch_token");
          return;
        }

        setLaunchToken(token);
        setLaunchTokenStatus("ready");

        // 过期前 60s 触发续期；若返回的 expires_at 不可信则按 4 分钟兜底
        const now = Math.floor(Date.now() / 1000);
        const ttlSeconds = typeof expiresAt === "number" && expiresAt > now
          ? expiresAt - now
          : 300;
        const refreshAfterMs = Math.max(30, ttlSeconds - 60) * 1000;
        refreshTimer = setTimeout(() => {
          if (!cancelled) {
            setLaunchTokenRefreshTick((tick) => tick + 1);
          }
        }, refreshAfterMs);
      } catch (e) {
        if (cancelled || (e as Error)?.name === "AbortError") return;
        setLaunchTokenStatus("error");
        setLaunchTokenError((e as Error)?.message || "请求失败");
      }
    };

    fetchLaunchToken();

    return () => {
      cancelled = true;
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [activeSection, activeBotId, accountId, launchTokenRefreshTick]);

  // 切到非 chat tab 或换 bot 时，清空已缓存的 token，避免泄露给下个 bot
  useEffect(() => {
    if (activeSection !== "chat") {
      setLaunchToken(null);
      setLaunchTokenStatus("idle");
      setLaunchTokenError(null);
    }
  }, [activeSection, activeBotId]);

  const retryLaunchToken = useCallback(() => {
    setLaunchTokenRefreshTick((tick) => tick + 1);
  }, []);

  const [memoryStatus, setMemoryStatus] = useState<MemoryLoadStatus>("idle");
  const [memorySnapshot, setMemorySnapshot] = useState<HermesMemorySnapshot | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [activeMemoryTab, setActiveMemoryTab] = useState<MemoryTabId>("memory");
  const [savingMemoryLimitTarget, setSavingMemoryLimitTarget] = useState<HermesMemoryLimitTarget | null>(null);
  const [memoryLimitSaveError, setMemoryLimitSaveError] = useState<{ target: HermesMemoryLimitTarget; message: string } | null>(null);
  const memoryRequestIdRef = useRef(0);
  const memorySaveRequestIdRef = useRef(0);
  const memorySaveInFlightRef = useRef<number | null>(null);
  const activeMemoryBotIdRef = useRef(activeBotId);
  activeMemoryBotIdRef.current = activeBotId;

  const loadHermesMemory = useCallback(async (options?: { clearSnapshot?: boolean }): Promise<HermesMemorySnapshot | null> => {
    const requestId = memoryRequestIdRef.current + 1;
    memoryRequestIdRef.current = requestId;
    const requestedBotId = activeBotId;

    if (!requestedBotId) {
      setMemorySnapshot(null);
      setMemoryStatus("error");
      setMemoryError(rawT("未找到当前 Hermes Agent 实例。"));
      return null;
    }

    if (activeBotStatus !== "running") {
      setMemorySnapshot(null);
      setMemoryStatus("error");
      setMemoryError(rawT("实例运行后才能读取记忆。"));
      return null;
    }

    if (options?.clearSnapshot !== false) {
      setMemorySnapshot(null);
    }
    setMemoryStatus("loading");
    setMemoryError(null);
    try {
      const snapshot = await fetchHermesMemorySnapshot(repositories.bots, requestedBotId);
      if (!isHermesMemoryOperationCurrent({
        activeBotId: activeMemoryBotIdRef.current,
        requestedBotId,
        latestRequestId: memoryRequestIdRef.current,
        requestId,
      })) return null;
      setMemorySnapshot(snapshot);
      setMemoryStatus("ready");
      return snapshot;
    } catch (err) {
      if (!isHermesMemoryOperationCurrent({
        activeBotId: activeMemoryBotIdRef.current,
        requestedBotId,
        latestRequestId: memoryRequestIdRef.current,
        requestId,
      })) return null;
      setMemoryStatus("error");
      setMemoryError(rawT("记忆读取命令执行失败：{{detail}}", {
        detail: err instanceof Error ? err.message : rawT("未知错误"),
      }));
      return null;
    }
  }, [activeBotId, activeBotStatus, repositories]);

  const clearHermesMemoryLimitSaveError = useCallback((target: HermesMemoryLimitTarget) => {
    setMemoryLimitSaveError((prev) => prev?.target === target ? null : prev);
  }, []);

  const saveHermesMemoryLimit = useCallback(async (target: HermesMemoryLimitTarget, value: number, existingChars: number) => {
    const requestedBotId = activeBotId;
    if (!requestedBotId) {
      setMemoryLimitSaveError({ target, message: rawT("未找到当前 Hermes Agent 实例。") });
      return false;
    }

    if (activeBotStatus !== "running") {
      setMemoryLimitSaveError({ target, message: rawT("实例运行后才能调整记忆上限。") });
      return false;
    }
    if (
      !canStartHermesMemoryLimitSave(savingMemoryLimitTarget)
      || memorySaveInFlightRef.current !== null
    ) {
      return false;
    }

    trackDatongEvent(DATONG_EVENTS.MEMORY_QUOTA_UPDATE, {
      pgid: DATONG_PAGE_IDS.AGENT_MEMORY,
      params: { bot_id: requestedBotId, target, old_quota: existingChars, new_quota: value },
    });
    const requestId = memorySaveRequestIdRef.current + 1;
    memorySaveRequestIdRef.current = requestId;
    memorySaveInFlightRef.current = requestId;
    setSavingMemoryLimitTarget(target);
    setMemoryLimitSaveError(null);

    const isCurrentRequest = () => isHermesMemoryOperationCurrent({
      activeBotId: activeMemoryBotIdRef.current,
      requestedBotId,
      latestRequestId: memorySaveRequestIdRef.current,
      requestId,
    });

    try {
      const saveResult = await executeHermesMemoryLimitSave({
        bots: repositories.bots,
        botId: requestedBotId,
        target,
        value,
        existingChars,
        getGatewayRestartCommand: async () => {
          const teaSdkRuntime = await loadTeaSdkRuntime();
          return teaSdkRuntime.getGatewayRestartCommand();
        },
      });
      if (!isCurrentRequest()) return false;

      if (saveResult.status === "failed") {
        setMemoryLimitSaveError({
          target,
          message: rawT("记忆上限调整失败：{{detail}}", { detail: saveResult.error.message }),
        });
        return false;
      }

      if (saveResult.status === "partial") {
        setMemoryLimitSaveError({
          target,
          message: rawT("配置已保存，但后续步骤失败。请刷新页面确认最新配置；如网关未重启，请到「设置 → 重启网关」手动重启。"),
        });
        return false;
      }

      setMemorySnapshot(saveResult.snapshot);
      setMemoryStatus("ready");
      setMemoryError(null);
      toast.success(rawT("修改成功，Hermes Agent 网关已重启。"));
      return true;
    } finally {
      if (memorySaveInFlightRef.current === requestId) {
        memorySaveInFlightRef.current = null;
      }
      if (isCurrentRequest()) {
        setSavingMemoryLimitTarget(null);
      }
    }
  }, [activeBotId, activeBotStatus, repositories, savingMemoryLimitTarget]);

  useEffect(() => {
    memoryRequestIdRef.current += 1;
    memorySaveRequestIdRef.current += 1;
    memorySaveInFlightRef.current = null;
    setSavingMemoryLimitTarget(null);
    setMemoryLimitSaveError(null);
  }, [activeBotId]);

  useEffect(() => {
    if (activeSection !== "memory") return;
    void loadHermesMemory();
  }, [activeSection, activeBotId, loadHermesMemory]);


  /**
   * tea-sdk-lightclaw 的 ModelCard / ChannelCard / SkillCard 内部通过
   * 自定义 `runCommand` + `getInvocationTask` 把命令下发到 mono 后端。
   *
   * 和存量业务（channel 配置、onboard、debug 排错等）保持一致，走通用
   * 入口 `POST /v1/instances/:botId/debug/exec`。国际站由后端直接使用腾讯云
   * TAT PtyExecCmdStream，国内站保持原 envd 执行链路。
   *
   * 业务约定：把 `activeBot.id` 作为 SDK `IInstanceInfo.InstanceId` 传入，
   * SDK 内部 `InstanceIds: [instance.InstanceId]` 原样透传给适配器，
   * 适配器从 `InstanceIds[0]` 拿到的就是 botId，无需额外映射或查询
   * sandbox_id。
   */
  const commandAdapter = useMemo(
    () =>
      createMonoDebugExecAdapter({
        baseUrl: resolveConfiguredAuthApiBaseUrl() ?? "",
        getAuthHeader: () => {
          const token = readStoredAuthToken();
          return token ? `Bearer ${token}` : undefined;
        },
        commandLifecycle: sdkCommandLifecycle,
      }),
    [sdkCommandLifecycle],
  );

  /**
   * LightVelaPanel 用的 commandExecutor。
   *
   * 与上方 `commandAdapter`（给 `@tencent/tea-sdk-lightclaw` SDK 走 TAT 协议
   * 的适配器）不同，LightVelaPanel 接受的是 ClawPanel 公共层定义的更直接的
   * `CommandExecutor` 契约（`(options) => Promise<{ taskStatus, exitCode, output, ... }>`）。
   *
   * 两者底层都走 mono debug/exec，但接口形状不同：
   *   - commandAdapter：runCommand → getInvocationTask 两步式（兼容 SDK 的 TAT 模型）
   *   - lightvelaCommandExecutor：单步同步返回（贴近 LightVelaPanel 期望）
   *
   * 仅在 activeBot 存在时构造；切换到无 bot 状态会传 undefined，让 panel
   * 内部 fallback 到默认 TAT 通道（实际 lightvela 场景不会走到）。
   */
  const lightvelaCommandExecutor = useMemo(
    () => activeBotId
      ? createLightVelaCommandExecutor(repositories, activeBotId)
      : undefined,
    [repositories, activeBotId],
  );

  /* 删除相关 */
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!activeBot || deleteInput !== activeBot.name) return;
    trackDatongClick("agent_delete_btn", {
      pgid: DATONG_PAGE_IDS.AGENTS_HOME,
      params: { bot_id: activeBot.id },
    });
    setDeleteError(null);
    try {
      await deleteBot(activeBot.id);
      setShowDeleteConfirm(false);
      setDeleteInput("");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("删除失败，请稍后重试。"));
    }
  };

  /*
   * 重置配置（轮换 API Key）相关
   * ──────────────────────────────────────────────────────────────
   * 服务端 reset 成功后旧 key 立即作废；前端必须把本次返回的新运行时
   * config 立刻下发到实例。若后续 acli 命令失败，用户再次重置会重新
   * rotate key，因此明文 apiKey 只保存在本次 try 块内，不进入 React state。
   */
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showAcliResetConfirm, setShowAcliResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resettingAcli, setResettingAcli] = useState(false);
  const [acliResetConsole, setAcliResetConsole] = useState<string[]>([]);
  const acliResetConsoleRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    setAcliResetConsole([]);
  }, [activeBot?.id]);

  useEffect(() => {
    const consoleEl = acliResetConsoleRef.current;
    if (!consoleEl) return;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }, [acliResetConsole]);

  const handleResetConfig = async () => {
    if (getResetBlockReason(activeBot, resetting)) return;
    const targetBotId = activeBot?.id;
    if (!targetBotId) return;

    trackDatongEvent(DATONG_EVENTS.DIAGNOSTICS_ACTION, {
      pgid: DATONG_PAGE_IDS.AGENT_DIAGNOSTICS,
      params: { bot_id: targetBotId, action: "reset_config" },
    });
    setResetting(true);
    try {
      const result = await repositories.bots.resetInstanceConfig(targetBotId);

      const resetBackendResult = await repositories.bots.execDebugCommand(
        targetBotId,
        "acli backend reset-config",
      );
      if (!isExecCommandSucceeded(resetBackendResult)) {
        throw new Error(
          t("初始化配置文件失败：{{detail}}", {
            detail: truncateExecOutput(resetBackendResult.output, resetBackendResult.status),
          }),
        );
      }

      const teaSdkRuntime = await loadTeaSdkRuntime();
      const providerSaveCmd = teaSdkRuntime.getProviderSaveCommand({
        name: result.config.providerName,
        baseUrl: result.config.baseUrl,
        api: result.config.api,
        apiKey: result.config.apiKey,
        models: [{ id: result.config.modelId, name: hermesModelName(result.config.modelId) }],
      });
      const providerSaveResult = await repositories.bots.execDebugCommand(targetBotId, providerSaveCmd);
      if (!isExecCommandSucceeded(providerSaveResult)) {
        const sanitizedOutput = result.config.apiKey
          ? providerSaveResult.output.replace(
            new RegExp(result.config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
            "sk-***",
          )
          : providerSaveResult.output;
        throw new Error(
          t("默认模型保存失败：{{detail}}", {
            detail: truncateExecOutput(sanitizedOutput, providerSaveResult.status),
          }),
        );
      }

      const switchModelCmd = teaSdkRuntime.getModelSwitchCommand(
        hermesSwitchModelFullId(result.config.providerName, result.config.modelId),
      );
      const switchModelResult = await repositories.bots.execDebugCommand(targetBotId, switchModelCmd);
      if (!isExecCommandSucceeded(switchModelResult)) {
        const sanitizedSwitchOutput = result.config.apiKey
          ? switchModelResult.output.replace(
            new RegExp(result.config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
            "sk-***",
          )
          : switchModelResult.output;
        throw new Error(
          t("默认模型切换失败：{{detail}}", {
            detail: truncateExecOutput(sanitizedSwitchOutput, switchModelResult.status),
          }),
        );
      }

      setShowResetConfirm(false);
      toast.success(t("重置成功"));
    } catch (err) {
      const fallbackMessage = t("重置失败，请重试");
      const message = isResetConfigRouteMissingError(err)
        ? t("当前后端服务暂不支持重置配置，请稍后再试。")
        : err instanceof Error ? err.message : fallbackMessage;
      toast.error(message);
    } finally {
      setResetting(false);
    }
  };

  const handleResetAcli = async () => {
    if (getAcliResetBlockReason(activeBot, resettingAcli)) return;
    const targetBotId = activeBot?.id;
    if (!targetBotId) return;

    trackDatongEvent(DATONG_EVENTS.DIAGNOSTICS_ACTION, {
      pgid: DATONG_PAGE_IDS.AGENT_DIAGNOSTICS,
      params: { bot_id: targetBotId, action: "reset_agent" },
    });
    setResettingAcli(true);
    setAcliResetConsole([`$ ${ACLI_RESET_COMMAND}`]);
    setShowAcliResetConfirm(false);
    try {
      const result = await execDebugCommandStream(targetBotId, ACLI_RESET_COMMAND, ({ stream, chunk }) => {
        setAcliResetConsole((prev) => [...prev, `[${stream}] ${chunk}`].slice(-80));
      });
      if (!isExecCommandSucceeded(result)) {
        throw new Error(truncateExecOutput(result.output, result.status));
      }
      setAcliResetConsole([]);
      toast.success(t("Agent 重置成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Agent 重置失败，请重试");
      setAcliResetConsole((prev) => [...prev, `[error] ${message}`].slice(-80));
      toast.error(t("Agent 重置失败，请重试"));
    } finally {
      setResettingAcli(false);
    }
  };

  /* 通道弹窗 */
  const [showChannelModal, setShowChannelModal] = useState(false);

  /* 出生证明 */
  const [showBirthCert, setShowBirthCert] = useState(false);

  /* ── 重启 Gateway ── */
  // restartingBotIds: 正在重启的 bot ID 集合，支持多 bot 并行重启
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [restartingBotIds, setRestartingBotIds] = useState<Set<string>>(new Set());
  const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);
  const [exportingBotIds, setExportingBotIds] = useState<Set<string>>(new Set());
  const [exportStatusByBotId, setExportStatusByBotId] = useState<Record<string, WorkerActionStatusResult | null>>({});
  const [exportStatusLoadingBotIds, setExportStatusLoadingBotIds] = useState<Set<string>>(new Set());
  const [exportStatusErrors, setExportStatusErrors] = useState<Record<string, string | null>>({});
  const [importingBotIds, setImportingBotIds] = useState<Set<string>>(new Set());
  const [importStatusByBotId, setImportStatusByBotId] = useState<Record<string, WorkerActionStatusResult | null>>({});
  const [importStatusLoadingBotIds, setImportStatusLoadingBotIds] = useState<Set<string>>(new Set());
  const [importStatusErrors, setImportStatusErrors] = useState<Record<string, string | null>>({});
  const [workspaceConfirm, setWorkspaceConfirm] = useState<WorkspaceConfirmState | null>(null);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  // 错误按 bot 维度存储，多 bot 并行失败时各自保留错误信息
  const [restartErrors, setRestartErrors] = useState<RestartErrors>(new Map());

  // execDebugCommand 是同步等待命令执行完成的接口。
  // 当返回 SUCCESS 时 `harness gateway restart` 已经执行完毕，
  // gateway 进程重启不会改变实例的 running 状态，因此不需要轮询。
  // 保留短暂视觉反馈（1.5s）让用户感知到操作已执行。
  const RESTART_FEEDBACK_MS = 1500;

  const handleRestartGateway = async () => {
    if (getRestartBlockReason(activeBot, restartingBotIds)) return;
    const targetBotId = activeBot!.id;
    trackDatongClick("agent_restart_btn", {
      pgid: DATONG_PAGE_IDS.AGENTS_HOME,
      params: { bot_id: targetBotId },
    });
    setRestartingBotIds((prev) => new Set(prev).add(targetBotId));
    setRestartErrors((prev) => clearErrorForBot(prev, targetBotId));
    try {
      const teaSdkRuntime = await loadTeaSdkRuntime();
      const result = await repositories.bots.execDebugCommand(targetBotId, teaSdkRuntime.getGatewayRestartCommand());
      const errorMsg = buildRestartErrorMessage(result);
      if (errorMsg) {
        setRestartErrors((prev) => setErrorForBot(prev, targetBotId, errorMsg));
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
        return;
      }
      // 命令已成功执行完毕，短暂保持视觉反馈后恢复
      setTimeout(() => {
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
      }, RESTART_FEEDBACK_MS);
    } catch (err) {
      setRestartErrors((prev) => setErrorForBot(prev, targetBotId, err instanceof Error ? err.message : t("重启失败")));
      setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
    }
  };

  const loadRescueExportStatus = useCallback(async (botId: string) => {
    setExportStatusLoadingBotIds((prev) => new Set(prev).add(botId));
    try {
      const status = await repositories.bots.getRescueExportStatus(botId);
      setExportStatusByBotId((prev) => ({ ...prev, [botId]: status }));
      setExportStatusErrors((prev) => ({ ...prev, [botId]: null }));
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : rawT("备份状态查询失败");
      setExportStatusErrors((prev) => ({ ...prev, [botId]: message }));
      throw err;
    } finally {
      setExportStatusLoadingBotIds((prev) => {
        const next = new Set(prev);
        next.delete(botId);
        return next;
      });
    }
  }, [repositories.bots]);

  const loadHermesImportStatus = useCallback(async (botId: string) => {
    setImportStatusLoadingBotIds((prev) => new Set(prev).add(botId));
    try {
      const status = await repositories.bots.getHermesImportStatus(botId);
      setImportStatusByBotId((prev) => ({ ...prev, [botId]: status }));
      setImportStatusErrors((prev) => ({ ...prev, [botId]: null }));
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : rawT("恢复状态查询失败");
      setImportStatusErrors((prev) => ({ ...prev, [botId]: message }));
      throw err;
    } finally {
      setImportStatusLoadingBotIds((prev) => {
        const next = new Set(prev);
        next.delete(botId);
        return next;
      });
    }
  }, [repositories.bots]);

  const handleRequestExportWorkspace = () => {
    if (workspaceActionDisabledReason) {
      toast.error(workspaceActionDisabledReason);
      return;
    }
    setWorkspaceConfirm({ kind: "export" });
  };

  const handleRequestImportWorkspace = () => {
    if (workspaceActionDisabledReason) {
      toast.error(workspaceActionDisabledReason);
      return;
    }
    setWorkspaceConfirm({ kind: "import", file: null });
  };

  const handleExportWorkspace = async () => {
    if (!activeBot || activeBot.status !== "running" || exportingBotIds.has(activeBot.id)) return;
    const targetBotId = activeBot.id;
    setWorkspaceConfirm(null);
    setExportingBotIds((prev) => new Set(prev).add(targetBotId));
    setExportStatusByBotId((prev) => ({
      ...prev,
      [targetBotId]: {
        phase: "starting",
        logs: [{ time: new Date().toISOString(), phase: "starting", message: t("正在发起 Agent 备份任务。"), level: "info" }],
      },
    }));
    try {
      await repositories.bots.startRescueExport(targetBotId);
      toast.success(t("备份任务已发起，完成后会发送到绑定邮箱。"));
      await loadRescueExportStatus(targetBotId).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("action_already_running")) {
        toast.success(t("已有备份任务正在执行，已为你加载当前进度。"));
        await loadRescueExportStatus(targetBotId).catch(() => undefined);
        return;
      }
      const friendlyMessage = message.includes("cos_upload_bucket_not_configured")
        ? t("备份存储桶未配置，请稍后再试。")
        : describeWorkspaceActionError("export", message || t("备份任务发起失败")).message;
      setExportStatusByBotId((prev) => ({
        ...prev,
        [targetBotId]: {
          phase: "failed",
          error: friendlyMessage,
          logs: [
            { time: new Date().toISOString(), phase: "failed", message: friendlyMessage, level: "error" },
          ],
        },
      }));
      toast.error(
        friendlyMessage,
      );
    } finally {
      setExportingBotIds((prev) => {
        const next = new Set(prev);
        next.delete(targetBotId);
        return next;
      });
    }
  };

  const handleSelectHermesImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (workspaceActionDisabledReason) {
      toast.error(workspaceActionDisabledReason);
      return;
    }
    setWorkspaceConfirm({ kind: "import", file });
  };

  const handleImportWorkspace = async (file: File) => {
    if (!activeBot || activeBot.status !== "running" || importingBotIds.has(activeBot.id)) return;
    const targetBotId = activeBot.id;
    setWorkspaceConfirm(null);
    setImportingBotIds((prev) => new Set(prev).add(targetBotId));
    setImportStatusByBotId((prev) => ({
      ...prev,
      [targetBotId]: {
        phase: "starting",
        logs: [{ time: new Date().toISOString(), phase: "starting", message: t("正在上传 Agent 恢复包。"), level: "info" }],
      },
    }));
    try {
      await repositories.bots.importHermesWorkspace(targetBotId, file);
      toast.success(t("恢复任务已发起，完成后会发送到绑定邮箱。"));
      await loadHermesImportStatus(targetBotId).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("action_already_running")) {
        toast.success(t("已有恢复任务正在执行，已为你加载当前进度。"));
        await loadHermesImportStatus(targetBotId).catch(() => undefined);
        return;
      }
      const friendlyMessage = describeWorkspaceActionError("import", message || t("恢复任务发起失败")).message;
      setImportStatusByBotId((prev) => ({
        ...prev,
        [targetBotId]: {
          phase: "failed",
          error: friendlyMessage,
          logs: [{ time: new Date().toISOString(), phase: "failed", message: friendlyMessage, level: "error" }],
        },
      }));
      toast.error(friendlyMessage);
    } finally {
      setImportingBotIds((prev) => {
        const next = new Set(prev);
        next.delete(targetBotId);
        return next;
      });
    }
  };

  // 当前 tab 的 bot 是否正在重启
  const isActiveBotRestarting = computeIsActiveBotRestarting(activeBot, restartingBotIds);
  const isActiveBotExporting = activeBot ? exportingBotIds.has(activeBot.id) : false;
  const isActiveBotImporting = activeBot ? importingBotIds.has(activeBot.id) : false;
  const activeExportStatus = activeBot ? exportStatusByBotId[activeBot.id] ?? null : null;
  const activeImportStatus = activeBot ? importStatusByBotId[activeBot.id] ?? null : null;
  const isActiveExportStatusLoading = activeBot ? exportStatusLoadingBotIds.has(activeBot.id) : false;
  const isActiveImportStatusLoading = activeBot ? importStatusLoadingBotIds.has(activeBot.id) : false;
  const activeExportStatusError = activeBot ? exportStatusErrors[activeBot.id] ?? null : null;
  const activeImportStatusError = activeBot ? importStatusErrors[activeBot.id] ?? null : null;
  const activeWorkspaceTask = selectCurrentWorkspaceTask(activeExportStatus, activeImportStatus);
  const workspaceActionDisabledReason = buildWorkspaceActionDisabledReason({
    hasActiveBot: Boolean(activeBot),
    botRunning: activeBot?.status === "running",
    hasEmail: Boolean(user?.email),
    resetting: resettingAcli,
    currentTask: activeWorkspaceTask,
  });
  // 当前 tab 是否展示错误
  const activeBotRestartError = getActiveBotRestartError(activeBot, restartErrors);
  const sdkInstance = useMemo<TeaSdkInstanceInfo | null>(() => {
    if (!activeBot) return null;
    return {
      InstanceId: activeBot.id,
      RegionId: 1,
    };
  }, [activeBot?.id]);
  const sdkFeatureFlags = useMemo<TeaSdkFeatureFlags>(() => ({
    gateway: true,
    channel: true,
    wecomChannel: true,
    adpChannel: false,
    wecomLongConn: true,
    yuanbaoChannel: false,
    weixinChannel: true,
    qrConfig: true,
    skills: true,
    webUI: false,
    memoryManagement: false,
    memoryV2: false,
    qqbotplugin: false,
  }), []);
  // 从七彩石拉取模型列表移到 TeaSdkSettingsPanel（需 runtime.useModelProviders）
  const { i18n } = useTranslation();
  const useEnglish = !!i18n.language?.startsWith("en");
  const sdkProductConfigArgs = useMemo(() => ({
    runCommand: commandAdapter.runCommand,
    getInvocationTask: commandAdapter.getInvocationTask,
  }), [commandAdapter]);
  const shouldExposeWorkspaceRecoveryPanel = shouldShowWorkspaceRecoveryPanel({
    isGlobalRegion: isGlobal,
    hiddenToolsRevealed: showHiddenAgentTools,
  });

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeBot?.id) return;
    void loadRescueExportStatus(activeBot.id).catch(() => undefined);
    void loadHermesImportStatus(activeBot.id).catch(() => undefined);
  }, [activeSection, activeBot?.id, loadRescueExportStatus, loadHermesImportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeBot?.id || !isRescueExportRunning(activeExportStatus)) return;
    const timer = window.setInterval(() => {
      void loadRescueExportStatus(activeBot.id).catch(() => undefined);
    }, RESCUE_EXPORT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSection, activeBot?.id, activeExportStatus?.phase, loadRescueExportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeBot?.id || !isRescueExportRunning(activeImportStatus)) return;
    const timer = window.setInterval(() => {
      void loadHermesImportStatus(activeBot.id).catch(() => undefined);
    }, RESCUE_EXPORT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSection, activeBot?.id, activeImportStatus?.phase, loadHermesImportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    return installOpenClawConsoleHelpers({
      host: window as Window & { help?: unknown; terminal?: unknown; show?: unknown; console: Console },
      getTerminalPath: () => (activeBot ? AGENT_SECTION_PATH_BY_ID.terminal : null),
      onShowHiddenTools: () => setShowHiddenAgentTools(true),
    });
  }, [activeBot]);

  useEffect(() => {
    if (!creatingParam) return;
    if (completedCreatingBot) {
      setIsCreating(false);
      setCreationError(null);
      setActiveTabId(completedCreatingBot.id);
      navigate(AGENTS_HOME_PATH, { replace: true });
      return;
    }
    if (creatingParam === "true" && !requestedCreatingBotId && !provisioningBot && !botsLoading) {
      setIsCreating(false);
      setCreationError(null);
      navigate(AGENTS_HOME_PATH, { replace: true });
      return;
    }
    setIsCreating(true);
    setCreationError(null);
    if (requestedCreatingBotId) {
      setActiveTabId(requestedCreatingBotId);
      return;
    }
    if (provisioningBot) {
      setActiveTabId(provisioningBot.id);
    }
  }, [creatingParam, requestedCreatingBotId, provisioningBot, completedCreatingBot, botsLoading, navigate]);

  /*
   * 刷新恢复：URL 丢 creating 参数但后端仍有 provisioning bot 时，把用户带回等待页。
   *
   * 与下方「兜底退出」存在 race：polling 退出后 URL 被清，期间「兜底退出」会主动
   * setIsCreating(false)；本 effect 若同帧把它翻回 true，下一帧「兜底退出」再翻
   * 回 false，最终收敛到非 loading 态。短暂闪烁可接受。
   */
  useEffect(() => {
    if (creatingParam || isCreating || botsLoading || !provisioningBot) return;
    setIsCreating(true);
    setCreationError(null);
    setActiveTabId(provisioningBot.id);
    navigate(`${AGENTS_HOME_PATH}?creating=${encodeURIComponent(provisioningBot.id)}`, { replace: true });
  }, [creatingParam, isCreating, botsLoading, provisioningBot, navigate]);

  /*
   * 兜底退出 loading：只看 bots 列表证据主动 setIsCreating(false)，收敛 polling
   * cleanup race（polling effect 在 await refreshBots 期间被自身 cleanup 抛弃，
   * setIsCreating(false) 永远没执行）。
   *
   *   模式 A：URL 携带 botId —— 只看该 botId，天然支持多 bot 并发，不误伤其他 provisioning。
   *   模式 B：URL 不指定 botId —— 无 provisioning bot 且有可见 bot 时退出。
   *
   * 不放 botsLoading 在 deps 里 —— refreshBots 期间必须能继续兜底，否则错过时机。
   */
  useEffect(() => {
    if (!isCreating || creationError) return;
    if (requestedCreatingBotId) {
      const targetBot = bots.find((b) => b.id === requestedCreatingBotId);
      if (targetBot && targetBot.status !== "provisioning" && targetBot.status !== "deleting") {
        setIsCreating(false);
        setCreationError(null);
        setActiveTabId(targetBot.id);
        navigate(AGENTS_HOME_PATH, { replace: true });
      }
      return;
    }
    if (!provisioningBot && bots.some((b) => b.status !== "provisioning" && b.status !== "deleting")) {
      setIsCreating(false);
      setCreationError(null);
      navigate(AGENTS_HOME_PATH, { replace: true });
    }
  }, [isCreating, creationError, requestedCreatingBotId, bots, provisioningBot, navigate]);

  /* 创建态只以后端真实状态为准：Running 才进入设置页，Failed/Deleting 停在错误态。 */
  useEffect(() => {
    if (!isCreating || creationError) return;

    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const pollCreationStatus = async () => {
      const targetBotId = requestedCreatingBotId || provisioningBot?.id;
      if (!targetBotId) {
        if (!cancelled && !botsLoading) {
          timer = window.setTimeout(pollCreationStatus, CREATING_POLL_INTERVAL_MS);
        }
        return;
      }

      try {
        const targetBot = await (async () => {
          try {
            const snapshot = await repositories.bots.getSettingsSnapshot(targetBotId);
            return snapshot.bot;
          } catch (detailError) {
            const dashboard = await repositories.bots.getDashboardSnapshot("live");
            const listedBot = dashboard.bots.find((bot) => bot.id === targetBotId);
            if (listedBot) return listedBot;
            throw detailError;
          }
        })();
        if (cancelled) return;

        if (targetBot.status === "active") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(AGENTS_HOME_PATH, { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status === "failed") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(AGENTS_HOME_PATH, { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status === "deleting") {
          setIsCreating(false);
          setCreationError(null);
          navigate(AGENTS_HOME_PATH, { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status !== "provisioning") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(AGENTS_HOME_PATH, { replace: true });
          await refreshBots();
          return;
        }
      } catch (err) {
        console.error("poll bot creation status failed:", err);
      }

      if (cancelled) return;

      if (Date.now() - startedAt >= CREATING_MAX_WAIT_MS) {
        setCreationError(t("Hermes Agent 仍在创建中，请稍后刷新页面查看状态。"));
        return;
      }

      if (!cancelled) {
        timer = window.setTimeout(pollCreationStatus, CREATING_POLL_INTERVAL_MS);
      }
    };

    void pollCreationStatus();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    isCreating,
    creationError,
    requestedCreatingBotId,
    provisioningBot?.id,
    repositories.bots,
    refreshBots,
    navigate,
  ]);

  const handleCreateNew = () => {
    trackDatongClick("agent_create_start_btn", {
      pgid: DATONG_PAGE_IDS.AGENTS_HOME,
      params: { bots_count: bots.length },
    });
    if (createLimitMessage) {
      setDirectCreateError(createLimitMessage);
      return;
    }
    if (isSubscribed) {
      // 已订阅：弹确认框，直接创建，不跳套餐页
      setDirectCreateError(null);
      setShowCreateConfirm(true);
    } else {
      // 未订阅：跳转套餐订阅页
      navigate("/subscribe");
    }
  };

  const handleConfirmCreate = async () => {
    trackDatongClick("agent_create_confirm_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CREATING,
      params: {},
    });
    setDirectCreating(true);
    setDirectCreateError(null);
    const createStart = Date.now();
    try {
      const newBot = await addBot({
        name: t("我的Hermes"),
        personality: t("默认设定"),
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
      });
      trackDatongEvent(DATONG_EVENTS.AGENT_CREATE_SUCCESS, {
        pgid: DATONG_PAGE_IDS.AGENT_CREATING,
        params: {
          bot_id: newBot.id,
          create_duration_ms: Date.now() - createStart,
        },
      });
      setShowCreateConfirm(false);
      // 进入页面内 loading 状态，带上新 bot id 供轮询定位
      setIsCreating(true);
      navigate(`${AGENTS_HOME_PATH}?creating=${encodeURIComponent(newBot.id)}`, { replace: true });
    } catch (err) {
      setDirectCreateError(getAgentCreateErrorMessage(err, (message) => t(message)));
    } finally {
      setDirectCreating(false);
    }
  };

  const avatarUrl = activeBot ? getAvatarForBot(activeBot.id) : "";
  const translateWorkspaceLabel = (label: string) => {
    switch (label) {
      case "发起中":
        return t("发起中");
      case "已完成":
        return t("已完成");
      case "未完成":
        return t("未完成");
      case "定位 Agent":
        return t("定位 Agent");
      case "准备导出环境":
        return t("准备导出环境");
      case "生成备份包":
        return t("生成备份包");
      case "上传备份包":
        return t("上传备份包");
      case "恢复运行环境":
        return t("恢复运行环境");
      case "连接 Agent":
        return t("连接 Agent");
      case "校验备份包":
        return t("校验备份包");
      case "恢复 Agent":
        return t("恢复 Agent");
      case "确认恢复结果":
        return t("确认恢复结果");
      case "清理临时文件":
        return t("清理临时文件");
      case "发送邮件":
        return t("发送邮件");
      case "恢复处理中":
        return t("恢复处理中");
      case "备份处理中":
        return t("备份处理中");
      default:
        return t("暂无任务");
    }
  };
  const workspacePhaseLabel = (kind: WorkspaceActionKind, phase?: string) => translateWorkspaceLabel(getWorkspaceTaskPhaseLabel(kind, phase));
  const translateWorkspaceErrorMessage = (message: string) => {
    switch (message) {
      case "导出环境启动超时，Agent 所在云主机仍在准备中。请稍后重试。":
        return t("导出环境启动超时，Agent 所在云主机仍在准备中。请稍后重试。");
      case "远程命令通道暂时不可用，请稍后重试。":
        return t("远程命令通道暂时不可用，请稍后重试。");
      case "备份包无法识别或已损坏，请重新选择 Hermes Agent 导出的 zip 文件。":
        return t("备份包无法识别或已损坏，请重新选择 Hermes Agent 导出的 zip 文件。");
      case "请选择 Hermes Agent 导出的 zip 文件。":
        return t("请选择 Hermes Agent 导出的 zip 文件。");
      case "请先在账号页绑定邮箱。":
        return t("请先在账号页绑定邮箱。");
      case "恢复过程中遇到异常，请稍后重试。":
        return t("恢复过程中遇到异常，请稍后重试。");
      case "备份过程中遇到异常，请稍后重试。":
        return t("备份过程中遇到异常，请稍后重试。");
      case "备份状态查询失败":
        return t("备份状态查询失败");
      case "恢复状态查询失败":
        return t("恢复状态查询失败");
      default:
        return message;
    }
  };
  const translateWorkspaceDisabledReason = (reason: string) => {
    switch (reason) {
      case "请选择正在运行的 Agent。":
        return t("请选择正在运行的 Agent。");
      case "Agent 运行中后才能使用备份或恢复任务。":
        return t("Agent 运行中后才能使用备份或恢复任务。");
      case "Agent 维护任务执行中，请稍后再试。":
        return t("Agent 维护任务执行中，请稍后再试。");
      case "请先在账号页绑定邮箱。":
        return t("请先在账号页绑定邮箱。");
      case "当前已有 Agent 备份任务运行中。":
        return t("当前已有 Agent 备份任务运行中。");
      case "当前已有 Agent 恢复任务运行中。":
        return t("当前已有 Agent 恢复任务运行中。");
      default:
        return reason;
    }
  };
  const workspaceTaskLabel = (kind: WorkspaceActionKind) => (kind === "export" ? t("Agent 备份") : t("Agent 恢复"));
  const workspaceTaskLogs = activeWorkspaceTask?.status.logs ?? [];
  const workspaceTaskPhase = activeWorkspaceTask?.status.phase;
  const isWorkspaceTaskLoading = isActiveExportStatusLoading || isActiveImportStatusLoading;
  const isWorkspaceTaskRunning = isWorkspaceActionRunning(activeWorkspaceTask?.status);
  const workspaceStatusErrorKind: WorkspaceActionKind =
    activeWorkspaceTask?.kind ?? (activeExportStatusError ? "export" : "import");
  const workspaceStatusError = activeWorkspaceTask?.kind === "export"
    ? activeExportStatusError
    : activeWorkspaceTask?.kind === "import"
      ? activeImportStatusError
      : activeExportStatusError || activeImportStatusError;
  const workspaceRawError = workspaceStatusError || activeWorkspaceTask?.status.error || "";
  const workspaceError = workspaceRawError
    ? describeWorkspaceActionError(workspaceStatusErrorKind, workspaceRawError)
    : null;
  const workspaceLastLogTime = workspaceTaskLogs.length > 0 ? workspaceTaskLogs[workspaceTaskLogs.length - 1]?.time : undefined;
  const canStartWorkspaceAction = !workspaceActionDisabledReason && !isActiveBotExporting && !isActiveBotImporting;
  const needsEmailBinding = workspaceActionDisabledReason === "请先在账号页绑定邮箱。";
  const workspaceDisabledReasonText = workspaceActionDisabledReason ? translateWorkspaceDisabledReason(workspaceActionDisabledReason) : null;
  const workspaceInlineDisabledReasonText = needsEmailBinding ? null : workspaceDisabledReasonText;
  const workspaceEmailBindingTooltip = needsEmailBinding ? (
    <>
      <span className="block text-pretty">
        {t("备份或恢复结果需要通过邮箱通知，请先绑定邮箱。")}
      </span>
      <AppLink to="/account" className="mt-1 inline-flex font-semibold text-black/85 underline underline-offset-2 hover:text-black">
        {t("前往账号页绑定邮箱")}
      </AppLink>
    </>
  ) : undefined;
  const formatExportLogTime = (value?: string) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  const copyWorkspaceDiagnostics = async () => {
    if (!activeWorkspaceTask) return;
    const lines = [
      `task=${activeWorkspaceTask.kind}`,
      `phase=${activeWorkspaceTask.status.phase}`,
      workspaceRawError ? `error=${workspaceRawError}` : "",
      ...workspaceTaskLogs.map((log) => `[${log.time ?? ""}] ${log.phase ?? ""} ${log.level ?? ""} ${log.message}`),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(activeWorkspaceTask.kind === "export" ? t("备份信息已复制") : t("恢复信息已复制"));
    } catch {
      toast.error(t("复制失败，请手动选择日志内容"));
    }
  };
  const workspaceDetailsToggleLabel = () => {
    if (activeWorkspaceTask?.kind === "export") {
      return workspaceDetailsOpen ? t("收起备份详情") : t("查看备份详情");
    }
    if (activeWorkspaceTask?.kind === "import") {
      return workspaceDetailsOpen ? t("收起恢复详情") : t("查看恢复详情");
    }
    return workspaceDetailsOpen ? t("收起备份或恢复详情") : t("查看备份或恢复详情");
  };
  const workspaceCopyLabel = activeWorkspaceTask?.kind === "export" ? t("复制备份信息") : t("复制恢复信息");
  const workspaceRecoveryPanel = shouldExposeWorkspaceRecoveryPanel && activeBot ? (
    <section className="rounded-md border border-black/[0.08] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-base font-semibold text-black/90 text-balance">{t("Agent 备份与恢复")}</h3>
        {needsEmailBinding && (
          <AppLink to="/account" className="text-xs font-medium text-black/45 underline underline-offset-2 transition-colors hover:text-black/70">
            {t("需前往账号页绑定邮箱")}
          </AppLink>
        )}
      </div>
      <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-black/65">
        <ul className="list-disc space-y-1 pl-4 text-pretty">
          <li>{t("备份范围是 Hermes Agent 的数据目录，包含 Hermes Agent 的配置、工作空间、记忆、已安装技能等数据。")}</li>
          <li>{t("从备份恢复会覆盖目标 Agent 的对应数据。备份、恢复成功或失败都会通过绑定邮箱通知。")}</li>
        </ul>
      </div>
      <input
        ref={importFileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => void handleSelectHermesImportFile(event)}
      />
      <div className="rounded-md border border-black/[0.06] bg-black/[0.02] px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn(
                "inline-flex h-2.5 w-2.5 rounded-full",
                workspaceTaskPhase === "completed"
                  ? "bg-emerald-500"
                  : workspaceTaskPhase === "failed"
                    ? "bg-red-500"
                    : activeWorkspaceTask
                      ? "bg-amber-500"
                      : "bg-black/20",
              )} />
              <span className="text-sm font-semibold text-black/85">
                {activeWorkspaceTask
                  ? `${workspaceTaskLabel(activeWorkspaceTask.kind)} · ${workspacePhaseLabel(activeWorkspaceTask.kind, workspaceTaskPhase)}`
                  : t("暂无 Agent 任务")}
              </span>
              {(isActiveBotExporting || isActiveBotImporting || isWorkspaceTaskLoading || isWorkspaceTaskRunning) && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-black/35" aria-hidden="true" />
              )}
            </div>
            <p className="mt-1 text-xs text-black/45">
              {activeWorkspaceTask
                ? workspaceLastLogTime
                  ? t("最近更新：{{time}}", { time: formatExportLogTime(workspaceLastLogTime) })
                  : t("正在等待任务状态更新")
                : t("可以备份当前 Agent，或从 Hermes Agent zip 备份恢复。")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!activeBot) return;
                void Promise.all([
                  loadRescueExportStatus(activeBot.id).catch(() => undefined),
                  loadHermesImportStatus(activeBot.id).catch(() => undefined),
                ]);
              }}
              disabled={isWorkspaceTaskLoading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-2.5 text-xs font-medium text-black/65 transition-colors hover:bg-black/[0.035] disabled:cursor-not-allowed disabled:text-black/25"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isWorkspaceTaskLoading && "animate-spin")} aria-hidden="true" />
              {t("刷新")}
            </button>
            <WorkspaceActionTooltip content={workspaceEmailBindingTooltip}>
              <button
                type="button"
                onClick={handleRequestExportWorkspace}
                disabled={!canStartWorkspaceAction}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-black/90 px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-black/20"
              >
                {isActiveBotExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
                {t("备份到邮箱")}
              </button>
            </WorkspaceActionTooltip>
            <WorkspaceActionTooltip content={workspaceEmailBindingTooltip}>
              <button
                type="button"
                onClick={handleRequestImportWorkspace}
                disabled={!canStartWorkspaceAction}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-black/90 px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-black/20"
              >
                {isActiveBotImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />}
                {t("从备份恢复")}
              </button>
            </WorkspaceActionTooltip>
          </div>
        </div>
        {workspaceInlineDisabledReasonText && (
          <p className="mt-3 text-xs leading-5 text-black/45">{workspaceInlineDisabledReasonText}</p>
        )}
        {workspaceError && (
          <div className="mt-3 flex gap-2 rounded-md border border-red-500/15 bg-red-500/[0.04] px-3 py-2 text-xs leading-relaxed text-red-600" role="status" aria-live="polite">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{translateWorkspaceErrorMessage(workspaceError.message)}</span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWorkspaceDetailsOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-2.5 text-xs font-medium text-black/55 transition-colors hover:bg-black/[0.035] hover:text-black/80"
            aria-expanded={workspaceDetailsOpen}
            aria-controls="workspace-recovery-details"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", workspaceDetailsOpen && "rotate-180")} aria-hidden="true" />
            {workspaceDetailsToggleLabel()}
          </button>
          {activeWorkspaceTask && (
            <button
              type="button"
              onClick={() => void copyWorkspaceDiagnostics()}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-2.5 text-xs font-medium text-black/55 transition-colors hover:bg-black/[0.035] hover:text-black/80"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {workspaceCopyLabel}
            </button>
          )}
        </div>
      </div>
      {workspaceDetailsOpen && (
        <div id="workspace-recovery-details" className="mt-4 max-h-[320px] overflow-y-auto pr-1">
          {workspaceTaskLogs.length === 0 ? (
          <div className="rounded-md border border-dashed border-black/[0.12] px-4 py-8 text-center text-sm text-black/45">
            {isWorkspaceTaskLoading ? t("正在读取任务状态...") : t("暂无 Agent 任务记录")}
          </div>
        ) : (
          <ol className="space-y-0">
            {workspaceTaskLogs.map((log, index, allLogs) => {
              const isLast = index === allLogs.length - 1;
              const tone = log.level === "error"
                ? "bg-red-500"
                : log.level === "success"
                  ? "bg-emerald-500"
                  : log.level === "warning"
                    ? "bg-amber-500"
                    : "bg-black/35";
              return (
                <li key={`${log.time ?? "log"}-${index}`} className="grid grid-cols-[72px_16px_minmax(0,1fr)] gap-3">
                  <div className="pt-0.5 text-right text-[11px] text-black/35">
                    {formatExportLogTime(log.time)}
                  </div>
                  <div className="relative flex justify-center">
                    <span className={cn("mt-1.5 h-2.5 w-2.5 rounded-full", tone)} />
                    {!isLast && <span className="absolute top-5 bottom-0 w-px bg-black/[0.08]" />}
                  </div>
                  <div className="pb-4">
                    <p className="text-sm leading-relaxed text-black/78">{log.message}</p>
                    {activeWorkspaceTask && log.phase && <p className="mt-0.5 text-[11px] text-black/35">{workspacePhaseLabel(activeWorkspaceTask.kind, log.phase)}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        </div>
      )}
    </section>
  ) : null;

  return (
    <div className="flex min-h-dvh flex-col bg-white" style={{ color: "rgba(0,0,0,0.90)" }}>
      {showHeader && <ProductReturnHomeHeader reloadLanguageAfterSwitch />}
      {automationModelSwitchDialog}

      <Dialog
        open={shouldExposeWorkspaceRecoveryPanel && Boolean(workspaceConfirm)}
        onOpenChange={(open) => {
          if (!open) setWorkspaceConfirm(null);
        }}
      >
        <DialogContent className="rounded-md border border-black/[0.08] bg-white p-5 shadow-xl md:w-[30rem]">
          {workspaceConfirm && (
            <>
              <DialogHeader className="pr-8">
                <DialogTitle>
                  {workspaceConfirm.kind === "export" ? t("备份 Hermes Agent") : t("从备份恢复 Agent")}
                </DialogTitle>
                <DialogDescription className="leading-relaxed">
                  {workspaceConfirm.kind === "export"
                    ? t("将打包 Hermes Agent 数据目录，并把备份下载链接发送到当前账号绑定邮箱。")
                    : t("选择 Hermes Agent 备份包恢复数据，恢复前请确认目标 Agent 和备份文件。")}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-black/[0.06] bg-black/[0.02] px-3 py-3 text-sm">
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2">
                    <span className="text-black/45">{t("目标 Agent")}</span>
                    <span className="min-w-0 truncate font-medium text-black/85" title={activeBot?.name}>
                      {activeBot?.name ?? t("当前 Agent")}
                    </span>
                    <span className="text-black/45">{t("数据目录")}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-black/70" title={HERMES_WORKSPACE_EXPORT_PATH}>
                      {HERMES_WORKSPACE_EXPORT_PATH}
                    </span>
                    {workspaceConfirm.kind === "import" ? (
                      <>
                        <span className="text-black/45">{t("备份文件")}</span>
                        <span className="min-w-0 truncate text-black/75" title={workspaceConfirm.file?.name}>
                          {workspaceConfirm.file
                            ? `${workspaceConfirm.file.name} · ${formatWorkspaceImportFileSize(workspaceConfirm.file.size)}`
                            : t("尚未选择备份文件")}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-black/45">{t("发送到")}</span>
                        <span className="min-w-0 truncate text-black/75" title={user?.email ?? undefined}>
                          {user?.email ?? t("绑定邮箱")}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {workspaceConfirm.kind === "export" ? (
                  <div className="rounded-md border border-black/[0.08] bg-white px-3 py-3 text-xs leading-relaxed text-black/65">
                    <p className="font-semibold text-black/80">{t("备份说明")}</p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-pretty">
                      <li>{t("备份范围包含 Hermes Agent 的配置、工作空间、记忆、已安装技能等数据。")}</li>
                      <li>{t("备份下载链接保留 8 小时，过期后需要重新发起备份。")}</li>
                      <li>{t("备份过程可能较久，请耐心等待；完成或失败都会通过绑定邮箱通知。")}</li>
                    </ul>
                  </div>
                ) : (
                  <>
                    <div className="rounded-md border border-black/[0.08] bg-white px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-black/80" title={workspaceConfirm.file?.name}>
                            {workspaceConfirm.file ? workspaceConfirm.file.name : t("选择 Hermes Agent zip 备份包")}
                          </p>
                          <p className="mt-1 text-xs text-black/45">
                            {workspaceConfirm.file
                              ? formatWorkspaceImportFileSize(workspaceConfirm.file.size)
                              : t("支持 Hermes Agent 导出的 .zip 备份包。")}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => importFileInputRef.current?.click()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-3 text-xs font-medium text-black/70 transition-colors hover:bg-black/[0.035]"
                        >
                          <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
                          {workspaceConfirm.file ? t("重新选择") : t("选择文件")}
                        </button>
                      </div>
                      {!workspaceConfirm.file && (
                        <p id="workspace-import-file-helper" className="mt-2 text-xs text-black/45">
                          {t("请选择 Hermes Agent 导出的 zip 备份包后再确认恢复。")}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-black/65" role="status">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600" aria-hidden="true" />
                      <div className="space-y-1 text-pretty">
                        <p className="font-semibold text-black/75">{t("恢复前请确认")}</p>
                        <p>{t("从备份恢复会覆盖目标 Agent 的 Hermes Agent 相关文件，包括配置、工作空间、记忆、已安装技能等数据。")}</p>
                        <p>{t("恢复成功或失败均会通过绑定邮箱通知。")}</p>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setWorkspaceConfirm(null)}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-3 text-sm font-medium text-black/65 transition-colors hover:bg-black/[0.035]"
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (workspaceConfirm.kind === "export") {
                      void handleExportWorkspace();
                      return;
                    }
                    if (!workspaceConfirm.file) return;
                    void handleImportWorkspace(workspaceConfirm.file);
                  }}
                  disabled={!canStartWorkspaceAction || (workspaceConfirm.kind === "import" && !workspaceConfirm.file)}
                  aria-describedby={workspaceConfirm.kind === "import" && !workspaceConfirm.file ? "workspace-import-file-helper" : undefined}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-black/90 px-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-black/20"
                >
                  {isActiveBotExporting || isActiveBotImporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : workspaceConfirm.kind === "export" ? (
                    <Download className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                  )}
                  {workspaceConfirm.kind === "export" ? t("确认备份") : t("确认恢复")}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      {showDeleteConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-[26.4rem] rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("删除智能体")}</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "12px" }}>
              {t("删除后会话将立即断开，数据将无法恢复。请谨慎操作！")}
            </p>
            <p style={{ color: "var(--lw-fg)", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              {t("如确认删除，请输入名称")}{" "}
              <span className="select-all rounded-md bg-red-50 px-1.5 py-0.5 font-semibold text-red-600">
                {activeBot.name}
              </span>
            </p>
            <input
              type="text"
              placeholder={t("请输入 {{name}}", { name: activeBot.name })}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]"
              style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }}
            />
            {deleteError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteError}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleDelete()}
                disabled={deleteInput !== activeBot.name}
                className="w-full rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all"
                style={{
                  backgroundColor: deleteInput === activeBot.name ? "#DC2626" : "#E5E7EB",
                  cursor: deleteInput === activeBot.name ? "pointer" : "not-allowed",
                  fontSize: "16px",
                }}
              >
                {t("确认删除")}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="py-2 text-[16px] transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer", fontSize: "16px" }}>
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Restart Gateway Confirm Dialog */}
      {showRestartConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!isActiveBotRestarting) setShowRestartConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "var(--tea-color-border-default-alpha4, rgba(238,238,238,0.4))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(0,0,0,0.04)" }}>
                <RefreshCw className="h-5 w-5" style={{ color: "rgba(0,0,0,0.62)" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("重启 Hermes Agent 网关")}</h3>
            </div>
            <p style={{ color: "var(--tea-color-text-secondary, #666)", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("重启期间 Agent 可能会短暂不可用，对话会短暂断开，确认重启？")}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  if (isActiveBotRestarting) return;
                  setShowRestartConfirm(false);
                  void handleRestartGateway();
                }}
                disabled={isActiveBotRestarting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-black/90 px-4 py-2.5 text-[16px] font-semibold text-white transition-all hover:opacity-90"
                style={{
                  cursor: isActiveBotRestarting ? "not-allowed" : "pointer",
                  fontSize: "16px",
                }}
              >
                {isActiveBotRestarting && <Loader2 className="h-4 w-4 animate-spin" />}
                {isActiveBotRestarting ? t("重启中...") : t("确认重启")}
              </button>
              <button
                onClick={() => setShowRestartConfirm(false)}
                disabled={isActiveBotRestarting}
                className="py-2 text-[16px] transition-colors hover:opacity-70"
                style={{ color: "var(--tea-color-text-secondary, #999)", background: "none", border: "none", cursor: isActiveBotRestarting ? "not-allowed" : "pointer", fontSize: "16px" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Reset Config Confirm Dialog */}
      {showResetConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!resetting) setShowResetConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "var(--tea-color-border-default-alpha4, rgba(238,238,238,0.4))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "var(--tea-color-warning-default-alpha10, rgba(245,158,11,0.10))" }}>
                <Wrench className="h-5 w-5" style={{ color: "var(--tea-color-warning-default, #F59E0B)" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("重置模型配置")}</h3>
            </div>
            <p style={{ color: "var(--tea-color-text-secondary, #666)", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("将初始化 Hermes Agent 的模型配置，")}
              <span className="font-semibold" style={{ color: "var(--tea-color-warning-default, #F59E0B)" }}>
                {t("模型相关配置不会保留。")}
              </span>
              {t("期间 Agent 可能短暂不可用，但工作空间、记忆、通道配置、已安装技能将会保留，确认继续？")}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleResetConfig()}
                disabled={resetting}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all"
                style={{
                  backgroundColor: resetting ? "var(--tea-color-bg-disabled, #E5E7EB)" : "var(--tea-color-warning-default, #F59E0B)",
                  cursor: resetting ? "not-allowed" : "pointer",
                  fontSize: "16px",
                }}
              >
                {resetting && <Loader2 className="h-4 w-4 animate-spin" />}
                {resetting ? t("恢复中...") : t("确认重置")}
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
                className="py-2 text-[16px] transition-colors hover:opacity-70"
                style={{ color: "var(--tea-color-text-secondary, #999)", background: "none", border: "none", cursor: resetting ? "not-allowed" : "pointer", fontSize: "16px" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Reset Agent Confirm Dialog */}
      {showAcliResetConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!resettingAcli) setShowAcliResetConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "var(--tea-color-border-default-alpha4, rgba(238,238,238,0.4))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "var(--tea-color-warning-default-alpha10, rgba(245,158,11,0.10))" }}>
                <RepairToolsIcon className="h-5 w-5" style={{ color: "var(--tea-color-warning-default, #F59E0B)" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("重装 Agent（保留数据）")}</h3>
            </div>
            <p style={{ color: "var(--tea-color-text-secondary, #666)", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("将执行 Hermes Agent 后台重装流程，")}
              <span className="font-semibold" style={{ color: "var(--tea-color-warning-default, #F59E0B)" }}>
                {t("期间 Agent 会有数分钟不可用。")}
              </span>
              {t("但工作空间、记忆、模型和通道配置、已安装技能将会保留，确认继续？")}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleResetAcli()}
                disabled={resettingAcli}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all"
                style={{
                  backgroundColor: resettingAcli ? "var(--tea-color-bg-disabled, #E5E7EB)" : "var(--tea-color-warning-default, #F59E0B)",
                  cursor: resettingAcli ? "not-allowed" : "pointer",
                  fontSize: "16px",
                }}
              >
                {resettingAcli && <Loader2 className="h-4 w-4 animate-spin" />}
                {resettingAcli ? t("重置中...") : t("确认重装")}
              </button>
              <button
                onClick={() => setShowAcliResetConfirm(false)}
                disabled={resettingAcli}
                className="py-2 text-[16px] transition-colors hover:opacity-70"
                style={{ color: "var(--tea-color-text-secondary, #999)", background: "none", border: "none", cursor: resettingAcli ? "not-allowed" : "pointer", fontSize: "16px" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Create Confirm Dialog */}
      {showCreateConfirm && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!directCreating) setShowCreateConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(7,193,96,0.08)" }}>
                <Plus className="h-5 w-5" style={{ color: "#07C160" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("创建智能体")}</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("即刻创建全新的 Hermes Agent")}
            </p>
            {directCreateError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{directCreateError}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleConfirmCreate()}
                disabled={directCreating}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all"
                style={{
                  backgroundColor: directCreating ? "#9CA3AF" : "var(--lw-fg)",
                  cursor: directCreating ? "not-allowed" : "pointer",
                  fontSize: "14px",
                  lineHeight: "20px",
                }}
              >
                {directCreating && <Loader2 className="h-4 w-4 animate-spin" />}
                {directCreating ? t("创建中...") : directCreateError ? t("重试") : t("确认创建")}
              </button>
              <button
                onClick={() => setShowCreateConfirm(false)}
                disabled={directCreating}
                className="py-2 text-sm transition-colors hover:opacity-70"
                style={{ color: "#999", background: "none", border: "none", cursor: directCreating ? "not-allowed" : "pointer", fontSize: "14px", lineHeight: "20px" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      <AnimatePresence>
        {renewPassModalOpen && activePass && (
          <RenewPassModal
            key="renew-pass"
            pass={activePass}
            onClose={() => setRenewPassModalOpen(false)}
            onSuccess={() => void handleRenewPassSuccess()}
            initialRealnameRequired={Boolean(session.user) && !renewalRealnameVerified}
          />
        )}
      </AnimatePresence>

      {/* Channel Modal */}
      {showChannelModal && activeBot && (
        <ChannelModal bot={activeBot} onClose={() => setShowChannelModal(false)} />
      )}

      {/* Birth Certificate */}
      {showBirthCert && activeBot && (
        <BirthCertificateModal bot={activeBot} onClose={() => setShowBirthCert(false)} />
      )}

      <main className="lw-app-top-pad flex-grow bg-white">
        <section className="lw-settings-shell">
          {/* ── Loading 状态 ── */}
          {isInitialBotsLoading && (
            <AgentSettingsDataLoading />
          )}

          {/* ── 创建 Loading 动画 ── */}
          {isCreating && (
            <CreatingLoadingView errorMessage={creationError} />
          )}

          {/* ── 设置区域 ── */}
          {!isCreating && activeBot && sdkInstance && (
            (() => {
              const settingsSections: { id: AgentSettingsSectionId; label: string; icon: React.ReactNode; path: string; badge?: string }[] = [
                { id: "channel", label: t("通道"), icon: <MessageCircle className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.channel },
                { id: "model", label: t("模型"), icon: <BrainCircuit className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.model },
                { id: "skill", label: t("技能"), icon: <Wand2 className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.skill },
                { id: "automations", label: t("自动任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
                { id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
                { id: "memory", label: t("记忆"), icon: <Database className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.memory },
                { id: "achievement", label: t("成就"), icon: <Trophy className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.achievement },
                { id: "files", label: t("云存储"), icon: <Files className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.files },
                ...(SHOW_AGENTCHAT_ENTRY
                  ? [{ id: "chat" as const, label: t("对话"), icon: <MessageSquare className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.chat }]
                  : []),
                { id: "diagnostics", label: t("诊断中心"), icon: <Stethoscope className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.diagnostics },
              ];
              const isRestartDisabled = resettingAcli || isActiveBotRestarting || activeBot.status !== "running";
              const restartTooltip = resettingAcli ? t("请稍后") : t("重启");
              const resetBlockReason = getResetBlockReason(activeBot, resetting);
              const resetDisabled = resettingAcli || resetting || resetBlockReason !== null;
              const resetTooltip =
                resettingAcli || resetBlockReason === RESET_BLOCK_REASON.NOT_RUNNING
                  ? t("请稍后")
                  : t("重置模型配置");
              const acliResetBlockReason = getAcliResetBlockReason(activeBot, resettingAcli);
              const acliResetDisabled = resettingAcli || acliResetBlockReason !== null;
              const acliResetTooltip =
                acliResetBlockReason === RESET_BLOCK_REASON.NOT_RUNNING
                  ? t("请稍后")
                  : t("重装 Agent（保留数据）");
              const deleteDisabled = resettingAcli;
              const deleteTooltip = deleteDisabled ? t("请稍后") : t("删除");
              const sectionFallback = TEA_SDK_SECTIONS.has(activeSection)
                ? null
                : (
                    <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-black/[0.06] bg-white text-sm text-black/45">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("正在加载页面…")}
                    </div>
                  );

              return (
                <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <aside className="lv-agents-sidebar lg:sticky lg:top-[84px]">
                    <div className="lv-agent-profile-wrap">
                      <div
                        role={visibleBots.length > 1 ? "button" : undefined}
                        tabIndex={visibleBots.length > 1 ? 0 : undefined}
                        onClick={() => {
                          if (visibleBots.length > 1) setIsAgentMenuOpen((open) => !open);
                        }}
                        onKeyDown={(event) => {
                          if (visibleBots.length <= 1) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setIsAgentMenuOpen((open) => !open);
                          }
                        }}
                        className={cn(
                          "lv-agent-profile",
                          visibleBots.length > 1 ? "hover:bg-black/[0.025]" : "cursor-default",
                        )}
                        aria-expanded={visibleBots.length > 1 ? isAgentMenuOpen : undefined}
                      >
                        <span className="lv-agent-avatar">
                          <img src={avatarUrl} alt="" />
                        </span>
                        <span className="lv-agent-profile-text">
                          <span className="lv-agent-profile-name" title={activeBot.name}>
                            {truncateBotName(activeBot.name)}
                          </span>
                          <span className="lv-agent-status-row">
                            <span className="lv-agent-status">
                              {isActiveBotRestarting ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <span
                                  className="inline-block h-1.5 w-1.5 rounded-full"
                                  style={{ background: getBotStatusColor(activeBot.status) }}
                                />
                              )}
                              {isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}
                            </span>
                            {passExpiryReminder && activePass && (
                              <span className="group relative inline-flex">
                                <button
                                  type="button"
                                  className={cn("lv-agent-renewal-badge cursor-pointer", `is-${passExpiryReminder.level}`)}
                                  aria-label={t("套餐{{time}}，点击续费", { time: passExpiryReminder.tooltip })}
                                  aria-describedby={passExpiryTooltipId}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setRenewPassModalOpen(true);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.stopPropagation();
                                    }
                                  }}
                                >
                                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                                  {passExpiryReminder.label}
                                </button>
                                <span className="pointer-events-none absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                  <span
                                    id={passExpiryTooltipId}
                                    role="tooltip"
                                    className="pointer-events-auto relative whitespace-nowrap rounded-[6px] border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-black/80 shadow-[0_8px_24px_rgba(15,23,42,0.12)] select-text"
                                  >
                                    {passExpiryReminder.tooltip}
                                    <button
                                      type="button"
                                      className="ml-2 cursor-pointer font-semibold text-[#A86108] underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A86108]/30"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setRenewPassModalOpen(true);
                                      }}
                                    >
                                      {t("立即续费")}
                                    </button>
                                    <span
                                      aria-hidden="true"
                                      className="absolute top-full left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-r border-b border-[var(--border-subtle)] bg-white"
                                    />
                                  </span>
                                </span>
                              </span>
                            )}
                          </span>
                        </span>
                        <div
                          ref={agentActionMenuRef}
                          className="lv-agent-actions"
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.stopPropagation();
                            }
                          }}
                        >
                          <button
                            type="button"
                            aria-expanded={isAgentActionMenuOpen}
                            aria-haspopup="menu"
                            aria-label={t("更多操作")}
                            className="lv-agent-more"
                            onClick={(event) => {
                              event.stopPropagation();
                              setIsAgentActionMenuOpen((open) => !open);
                            }}
                          >
                            <MoreVertical className="h-4 w-4" aria-hidden="true" />
                          </button>
                          {isAgentActionMenuOpen && (
                            <div role="menu" className="lv-agent-action-menu" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                role="menuitem"
                                aria-label={restartTooltip}
                                disabled={isRestartDisabled}
                                onClick={() => {
                                  setIsAgentActionMenuOpen(false);
                                  if (isRestartDisabled) return;
                                  setShowRestartConfirm(true);
                                }}
                              >
                                {t("重启")}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                aria-label={deleteTooltip}
                                disabled={deleteDisabled}
                                className="is-danger"
                                onClick={() => {
                                  setIsAgentActionMenuOpen(false);
                                  if (deleteDisabled) return;
                                  setDeleteInput("");
                                  setShowDeleteConfirm(true);
                                }}
                              >
                                {t("删除")}
                              </button>
                            </div>
                          )}
                        </div>
                        {visibleBots.length > 1 && (
                          <ChevronDown
                            className={cn("h-4 w-4 flex-shrink-0 text-black/35 transition-transform", isAgentMenuOpen && "rotate-180")}
                          />
                        )}
                      </div>
                      {visibleBots.length > 1 && isAgentMenuOpen && (
                        <div className="mt-1 rounded-md bg-black/[0.025] p-1">
                          {visibleBots.map((bot) => {
                            const isActive = bot.id === activeTabId;
                            return (
                              <button
                                key={bot.id}
                                type="button"
                                onClick={() => {
                                  setActiveTabId(bot.id);
                                  setIsAgentMenuOpen(false);
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors",
                                  isActive ? "bg-white text-black/90 shadow-sm" : "text-black/55 hover:bg-white/70 hover:text-black/80",
                                )}
                              >
                                <img src={getAvatarForBot(bot.id)} alt="" className="h-5 w-5 flex-shrink-0 rounded object-contain" />
                                <span className="min-w-0 flex-1 truncate" title={bot.name}>
                                  {truncateBotName(bot.name)}
                                </span>
                                {isActive && <Check className="h-3.5 w-3.5 text-black/55" />}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {activeBotRestartError && (
                        <p className="mt-2 px-1 text-xs leading-relaxed text-red-500">{activeBotRestartError}</p>
                      )}

                      {canCreateBot && (
                        <button
                          type="button"
                          onClick={handleCreateNew}
                          className="lv-agent-create-button"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {t("立即创建")}
                        </button>
                      )}
                    </div>

                    <nav
                      aria-label={t("实例配置导航")}
                      className="lv-agents-nav"
                    >
                      {showHiddenAgentTools ? (
                        <>
                          <AppLink
                            to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.terminal, searchParams)}
                            aria-current={activeSection === "terminal" ? "page" : undefined}
                            className={cn(
                              "lw-settings-nav-item lv-agents-nav-item",
                              activeSection === "terminal"
                                ? "is-active"
                                : "text-black/70 hover:bg-black/[0.025]",
                            )}
                          >
                            <span className="lv-agents-nav-icon"><TerminalSquare className="h-4 w-4" /></span>
                            <span className="flex-1 text-left">{t("终端")}</span>
                          </AppLink>
                          <AppLink
                            to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.browser, searchParams)}
                            aria-current={activeSection === "browser" ? "page" : undefined}
                            className={cn(
                              "lw-settings-nav-item lv-agents-nav-item",
                              activeSection === "browser"
                                ? "is-active"
                                : "text-black/70 hover:bg-black/[0.025]",
                            )}
                          >
                            <span className="lv-agents-nav-icon"><Globe2 className="h-4 w-4" /></span>
                            <span className="flex-1 text-left">{t("浏览器")}</span>
                          </AppLink>
                        </>
                      ) : null}
                      {settingsSections.map((section) => {
                        const isActive = section.id === activeSection;
                        return (
                          <AppLink
                            key={section.id}
                            to={getAgentSectionHref(section.path, searchParams)}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "lw-settings-nav-item lv-agents-nav-item",
                              isActive
                                ? "is-active"
                                : "text-black/70 hover:bg-black/[0.025]",
                            )}
                          >
                            <span className="lv-agents-nav-icon">{section.icon}</span>
                            <span className="flex-1 text-left">{section.label}</span>
                            {section.badge && (
                              <span className="rounded-full bg-[#f76724] px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">
                                {section.badge}
                              </span>
                            )}
                          </AppLink>
                        );
                      })}
                    </nav>

                    {isCN ? (
                      <a
                        href={PRODUCT_FEEDBACK_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="lv-agent-feedback-link"
                      >
                        <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{t("有建议？提交反馈")}</span>
                      </a>
                    ) : null}
                  </aside>

                  <section className="min-w-0">
                    <div key={`${activeBot.id}-${activeSection}`} className="_lh-claw-bot-panel">
                      <Suspense
                        fallback={sectionFallback}
                      >
                        <div className="_lh-claw-bot-panel__cards min-w-0">
                          {activeSection === "channel" && (
                            <TeaSdkSettingsPanel
                              kind="channel"
                              instance={sdkInstance}
                              featureFlags={sdkFeatureFlags}
                              productConfigArgs={sdkProductConfigArgs}
                              useEnglish={useEnglish}
                            />
                          )}
                          {activeSection === "model" && (
                            <TeaSdkSettingsPanel
                              kind="model"
                              instance={sdkInstance}
                              featureFlags={sdkFeatureFlags}
                              productConfigArgs={sdkProductConfigArgs}
                              useEnglish={useEnglish}
                            />
                          )}
                          {activeSection === "skill" && (
                            <HermesAgentSkillsPanel
                              botId={activeBot.id}
                              execDebugCommand={repositories.bots.execDebugCommand}
                              initialSectionSlug={initialSectionSlug}
                            />
                          )}
                          {activeSection === "buddy" && (
                            <BuddyPanel botId={activeBot.id} />
                          )}
                          {activeSection === "achievement" && (
                            <AchievementsPanel botId={activeBot.id} botName={activeBot.name} />
                          )}
                          {activeSection === "automations" && (
                            <HermesAgentAutomationsPanel botId={activeBot.id} />
                          )}
                          {activeSection === "diagnostics" && (
                            <AgentDiagnosticsPanel
                              botId={activeBot.id}
                              execDebugCommand={repositories.bots.execDebugCommand}
                              resetConfigAction={{
                                disabled: resetDisabled,
                                loading: resetting,
                                tooltip: resetTooltip,
                                onExecute: () => {
                                  if (resetDisabled) return;
                                  setShowResetConfirm(true);
                                },
                              }}
                              resetAgentAction={{
                                disabled: acliResetDisabled,
                                loading: resettingAcli,
                                tooltip: acliResetTooltip,
                                onExecute: () => {
                                  if (acliResetDisabled) return;
                                  setShowAcliResetConfirm(true);
                                },
                              }}
                              resetAgentConsole={acliResetConsole}
                              resetAgentConsoleRef={acliResetConsoleRef}
                              workspaceRecoveryPanel={workspaceRecoveryPanel}
                            />
                          )}
                          {activeSection === "chat" && (
                            <AgentChatPanel
                              accountId={accountId}
                              commandExecutor={lightvelaCommandExecutor}
                              instanceId={sdkInstance.InstanceId}
                              launchToken={launchToken}
                              launchTokenError={launchTokenError}
                              launchTokenStatus={launchTokenStatus}
                              onRetryLaunchToken={retryLaunchToken}
                            />
                          )}
                          {activeSection === "memory" && (
                            <MemoryPanel
                              status={memoryStatus}
                              snapshot={memorySnapshot}
                              error={memoryError}
                              activeTab={activeMemoryTab}
                              onTabChange={setActiveMemoryTab}
                              onRefresh={loadHermesMemory}
                              onSaveLimit={saveHermesMemoryLimit}
                              onDraftChange={clearHermesMemoryLimitSaveError}
                              savingLimitTarget={savingMemoryLimitTarget}
                              limitSaveError={memoryLimitSaveError}
                              t={t}
                            />
                          )}
                          {activeSection === "files" && (
                            <TatFileManagerPanel botId={activeBot.id} />
                          )}
                          {activeSection === "browser" && (
                            <TatHermesWebPanel botId={activeBot.id} />
                          )}
                          {activeSection === "terminal" && (
                            <TerminalPanel botId={activeBot.id} botName={activeBot.name} />
                          )}
                        </div>
                      </Suspense>
                    </div>
                  </section>
                </div>
              );
            })()
          )}

          {/* 空状态 */}
          {
            !isCreating && !botsLoading && visibleBots.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-sm" style={{ color: "rgba(0,0,0,0.40)" }}>{t("即刻创建你的云端智能体伙伴")}</p>
                {createLimitMessage && (
                  <p className="mt-3 max-w-sm text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.48)" }}>
                    {createLimitMessage}
                  </p>
                )}
                <button
                  onClick={handleCreateNew}
                  disabled={!canCreateBot}
                  className={cn(
                    "mt-6 inline-flex items-center gap-2 rounded-full px-6 py-2.5 font-semibold text-white transition-all",
                    canCreateBot
                      ? "bg-black/90 hover:opacity-90"
                      : "cursor-not-allowed bg-black/30",
                  )}
                  style={{ marginTop: 20, fontSize: 14, lineHeight: "20px" }}
                >
                  {canCreateBot ? t("立即创建") : t("暂不可创建")}
                </button>
              </div>
            )
          }

        </section>
      </main>

      <ProductFooter />
    </div>
  );
};
