import { AgentSidebar, AgentSidebarToggle, useAgentSidebarCollapse } from "@/components/site/agent-sidebar";
import { AgentConsoleHostProjection, type AgentConsoleHostPort } from "./agent-console-host";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  CalendarClock,
  BrainCircuit,
  ChevronDown,
  Check,
  Copy,
  Globe2,
  House,
  LayoutDashboard,
  PanelLeft,
  MessageCircle,
  Plug,
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
  SlidersHorizontal,
  Settings2,
  Stethoscope,
  AlertTriangle,
  Crown,
  TerminalSquare,
  Trophy,
  Download,
  FlaskConical,
  Monitor,
  Plus,
  RefreshCw,
  UploadCloud,
  UserRound,
  Wand2,
  Wrench,
  Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Fragment, lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, useId, useLayoutEffect, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/asset-url";
import { ProductReturnHomeHeader } from "@/components/site/product-chrome";
import { useIsDesktop } from "@/components/site/public-site-header";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { AgentSectionHeader } from "@/components/domain/agent-section-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOpenClaw, type OpenClawBot } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { useMultiBotEnabled, usePaidBillingEnabled, useRealnamePhoneVerificationEnabled, useCloudDesktopEnabled } from "@/contexts/runtime-config-context";
import { useCurrentLocale, useT, t as rawT } from "@/i18n/t";
import { useTranslation } from "react-i18next";
import { isGlobal } from "@/lib/region";
import { agentChatPageMinHeightClass, bindChatVisualViewportHeight } from "./agent-chat-visual-viewport";
import { isConsoleShowEnabled, subscribeConsoleShow } from "@/lib/console-show-event";
import { resolveBotCloneIntent } from "@lightvela/agent-core";
// agent-config 本地模块统一从 barrel 导入。
// 注：scripts SDK 的 window 副作用已在 useAgentInternals 内以运行时动态 import
// 治本（见该文件说明），barrel 顶层已无 SSR 危险依赖，页面层可安全静态导入。
import {
  createLighthouseConfig,
  useModelProviders,
  createLocalCommandExecutor,
  type ICommandExecutor,
  type IProductConfig,
} from "@/pages/marketing/agent-config";
import { AgentModelConfigPanel } from "@/pages/marketing/agent-model-config/agent-model-config-panel";
import {
  createHermesModelConfigClient,
  HermesModelConfigResponseError,
} from "@/pages/marketing/agent-model-config/model-config-client";
import { resolveProductModelProviderOptions } from "@/pages/marketing/agent-model-config/product-provider-adapter";
import { getHermesScriptCommands } from "@/pages/marketing/agent-config/scripts-runtime";
import { useSession } from "@/contexts/session-context";
import { AppLink, useAppLocation, useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { createDebugExecRequestBody } from "@/lib/debug-exec-request";
// 多会话桥接类型经 agent-chat-panel 的 type re-export 引入（单一事实源，见该文件说明）。
import type {
  LightVelaMultiSessionOptions,
  LightVelaSession,
  LightVelaSessionActions,
} from "./agent-chat-panel";
import { resolveAgentSidebarEmptySessionState, runBotScopedSessionPin, useAgentSidebarSessionList, useAgentSidebarUnreadSessions } from "./agent-sidebar-session-list";
import { AUTH_SERVICE_UNAVAILABLE_MESSAGE, readStoredAuthToken } from "@/repositories/http-repositories";
import {
  AGENTS_HOME_PATH,
  AGENT_BOT_QUERY_KEY,
  AGENT_CREATE_QUERY_KEY,
  AGENT_CREATE_PAGE_QUERY_KEY,
  AGENT_SECTION_PATH_BY_ID,
  getAgentBotSectionHref,
  getAgentSectionHref,
  type AgentSettingsSectionId,
} from "@/lib/agent-routes";
import type { Repositories, WorkerActionStatusResult } from "@/repositories/types";
import { composeDebugExecCommandLifecycles } from "@/pages/marketing/agent-debug-exec-lifecycle";
import { getAgentCreateErrorMessage } from "@/pages/marketing/agent-create-error";
import { useAutomationAwareModelSwitch } from "@/pages/marketing/agent-model-switch-automation-sync";
import { createQqbotGroupPolicyCommandLifecycle } from "@/pages/marketing/agent-qqbot-group-policy";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/agent-console-helpers";
import {
  resolveAgentConsoleCollectionLabel,
  resolveAgentDisplayName,
  resolveAgentSessionTitle,
  shouldUseEnglishProviderData,
} from "@/pages/marketing/agent-provider-locale";
import {
  fetchHermesMemorySnapshot,
  getHermesMemoryLimitBounds,
  getMemoryUsagePercent,
  isHermesMemoryLimitNearUsage,
  splitHermesMemoryEntries,
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
import { AgentOnboardingPanel, useDemoOnboarding } from "@/pages/marketing/agent-onboarding-panel";
import { useBuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { AgentBotRail } from "@/pages/marketing/agent-bot-rail";
import { getBotStatusColor, getBotStatusLabel } from "@/pages/marketing/agent-bot-status";
import {
  clearPendingOnboarding,
  hasAgentSidebarLayout,
  IS_BUDDY_ONBOARDING_ENABLED,
  isPendingOnboarding,
  markPendingOnboarding,
  shouldShowEarlyOnboarding,
  resolveOnboardingProfileId,
} from "@/pages/marketing/agent-onboarding-mark";
import { hasUnfinishedBuddySetup } from "@/pages/marketing/agent-buddy-setup-progress";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";
import { shouldShowAgentSettingsDataLoading } from "@/pages/marketing/agent-settings-loading";
import { AgentSettingsLoadingContent } from "@/pages/marketing/agent-settings-loading-view";
import { AgentUpgradingView } from "@/pages/marketing/agent-upgrading-view";
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
import {
  findCompletedCreatingBot,
  getOpenClawCreateLimitMessage,
  resolveOpenClawCreatePermissions,
} from "@/pages/marketing/agent-create-availability";
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
  isExecCommandSucceeded,
  isResetConfigRouteMissingError,
  truncateExecOutput,
  ACLI_RESET_COMMAND,
  RESET_BLOCK_REASON,
} from "@/pages/marketing/agent-reset-config";
import { toast } from "@/lib/toast";
import { isPaidBillingEnabled } from "@/lib/billing-flow";
import { getPassExpiryReminder, type PassExpiryReminder } from "@/lib/pass-renewal";
import { isRenewalRealnameVerified } from "@/lib/renewal-realname";
import { RenewPassModal } from "@/pages/marketing/renew-pass-modal";
import { AgentDeepSeekHarnessPanel } from "@/pages/marketing/agent-deepseek-harness-panel";
import { AgentCloudDesktopPanel } from "@/pages/marketing/agent-cloud-desktop-panel";
import { isRenewalAvailableForRegion } from "@/pages/marketing/renew-coming-soon";
import { trackDatongClick, trackDatongEvent } from "@/observability/datong-tracker";
import { DATONG_EVENTS, DATONG_PAGE_IDS } from "@/observability/datong";
import {
  AgentChatMigrationSurface,
  type EmbeddedSessionCommands,
  type EmbeddedSessionMutationState,
} from "@/pages/marketing/opencraft-embedded-workbench";
import { useAgentSessionPagination } from "@/pages/marketing/agent-session-pagination";

const MAX_BOT_NAME_LENGTH = 60;

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
const AgentWebsitePanel = lazy(() =>
  import("@/pages/marketing/agent-website-panel").then((module) => ({ default: module.AgentWebsitePanel })),
);
const AgentCommonSettingsPanel = lazy(() =>
  import("@/pages/marketing/agent-common-settings-panel").then((module) => ({ default: module.AgentCommonSettingsPanel })),
);
const BuddyPanel = lazy(() =>
  import("@/pages/marketing/agent-buddy-panel").then((module) => ({ default: module.BuddyPanel })),
);
const HermesAgentSkillsPanel = lazy(() =>
  import("@/pages/marketing/agent-skills-panel").then((module) => ({ default: module.HermesAgentSkillsPanel })),
);
const AchievementsPanel = lazy(() =>
  import("@/pages/marketing/agent-achievements-panel").then((module) => ({ default: module.AchievementsPanel })),
);
const AgentBotProfileEditor = lazy(() =>
  import("@/pages/marketing/agent-bot-profile-editor").then((module) => ({ default: module.AgentBotProfileEditor })),
);
const HermesAgentAutomationsPanel = lazy(() =>
  import("@/pages/marketing/agent-automations-panel").then((module) => ({ default: module.HermesAgentAutomationsPanel })),
);

// ChannelPanel / ModelPanel 已本地化（agent-config），用 lazy 做代码分割，
// 与其他面板一致。内部依赖全部指向本地 config/hooks，仅 scripts 命令生成走
// SDK `/scripts` 子入口（纯 TS、无浏览器副作用）。
const AgentChannelPanel = lazy(() =>
  import("@/pages/marketing/agent-channel-panel").then((module) => ({ default: module.ChannelPanel })),
);

// 连接器面板（P1）：列表/授权/断开全走 ai-server 连接器平台。
// lazy 与其他面板一致；instanceId 取 TeaSdk 实例标识。
const AgentConnectorsPanel = lazy(() =>
  import("@/pages/marketing/agent-connectors-panel").then((module) => ({ default: module.ConnectorsPanel })),
);
type Translate = (text: string, options?: Record<string, unknown>) => string;

function getPassExpiryReminderCopy(reminder: PassExpiryReminder, t: Translate) {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneHourMs = 60 * 60 * 1000;
  const label = reminder.label === "临近到期" ? t("临近到期") : t("即将到期");

  if (reminder.remainingMs < oneDayMs) {
    const hours = Math.ceil(reminder.remainingMs / oneHourMs);
    return {
      label,
      tooltip: hours < 1 ? t("剩余不足 1 小时到期") : t("剩余 {{hours}} 小时到期", { hours }),
    };
  }

  return {
    label,
    tooltip: t("剩余 {{days}} 天到期", { days: Math.ceil(reminder.remainingMs / oneDayMs) }),
  };
}

type TeaSdkInstanceInfo = {
  InstanceId: string;
  ProfileId?: string;
  RegionId: number;
  Zone?: string;
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

/**
 * 通道/模型配置面板接入层。
 *
 * ChannelPanel / ModelPanel 已完全本地化（agent-config），其 productConfig、
 * scriptCommands 均可由组件内部 createLighthouseConfig()/createLightClawScripts()
 * 兜底。宿主这里只需补两处组件默认值给不了的差异：
 *   1. isI18n：国际站 provider 过滤（国内/国际站模型列表不同）
 *   2. commandExecutor：mono2 的本地命令执行器（直连 debug/exec，脱离 SDK TAT）
 *
 * 用本地 useModelProviders 拉取模型列表、本地 createLighthouseConfig 生成
 * IProductConfig，再叠加宿主命令执行器，得到类型正确的 productConfig +
 * commandExecutor 直接传入 lazy Panel（Suspense 兜加载态）。
 */
function TeaSdkSettingsPanel({
  kind,
  instance,
  featureFlags,
  commandExecutor,
  execDebugCommand,
  useEnglish,
  channelAfterDescription,
  whatsAppOccupiedByOther,
}: {
  kind: "channel" | "model";
  instance: TeaSdkInstanceInfo;
  featureFlags: TeaSdkFeatureFlags;
  commandExecutor?: ICommandExecutor;
  execDebugCommand?: Repositories["bots"]["execDebugCommand"];
  /** 是否取英文文案（语言维度），与 isI18n 是两个维度（国内站可切英文） */
  useEnglish: boolean;
  /** 通道页标题说明后的上下文提示；模型页不会消费。 */
  channelAfterDescription?: ReactNode;
  whatsAppOccupiedByOther?: boolean;
}) {
  const t = useT();
  const modelProviders = useModelProviders({ isI18n: isGlobal, useEnglish });

  const productConfig = useMemo<IProductConfig>(() => {
    // 本地 createLighthouseConfig 内部的 getFilteredModelProviders 已用 isI18n
    // 正确过滤国内/国际站 provider，无需再套 SDK 那套 IS_I18N hidden-providers hack。
    const config = createLighthouseConfig({
      agentType: "hermes",
      supportsTencentCloudApi: false,
      isI18n: isGlobal,
      modelProviders,
    });
    return {
      ...config,
      acliProduct: "lightvela",
    };
  }, [modelProviders]);

  if (kind === "model") {
    if (!execDebugCommand) {
      return (
        <div className="rounded-md border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {rawT("未找到当前 Hermes Agent 实例。")}
        </div>
      );
    }
    return (
      <AgentModelConfigPanel
        botId={instance.InstanceId}
        profileId={instance.ProfileId}
        execDebugCommand={execDebugCommand}
        providers={resolveProductModelProviderOptions(productConfig, modelProviders, {
          region: instance.Zone,
          regionId: instance.RegionId,
        })}
        isGlobalRegion={isGlobal}
      />
    );
  }

  // 面板经 lazy() 动态加载，SSR 静态导出预渲染时走 Suspense fallback、不求值
  // 面板模块；客户端 hydrate 后才真正 import。scripts SDK 的 window 副作用也已
  // 在 useAgentInternals 内动态 import 治本，无需再手动区分 SSR / 客户端。
  return (
    <StableTeaSdkPanelHost>
      <Suspense
        fallback={
          <div className="flex items-center justify-center rounded-md border border-black/[0.06] bg-white py-16 text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("正在加载...")}
          </div>
        }
      >
        <AgentChannelPanel
          instance={instance}
          featureFlags={featureFlags}
          productConfig={productConfig}
          commandExecutor={commandExecutor}
          afterDescription={channelAfterDescription}
          whatsAppOccupiedByOther={whatsAppOccupiedByOther}
        />
      </Suspense>
    </StableTeaSdkPanelHost>
  );
}

/* ─── Types ─── */

// Solar Icons: solar:restart-bold. The arrow joins the circular stroke.
const RestartIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M18.2577 3.50828C18.538 3.62437 18.7207 3.89785 18.7207 4.20119V8.44383C18.7207 8.85805 18.3849 9.19383 17.9707 9.19383H13.728C13.4247 9.19383 13.1512 9.0111 13.0351 8.73085C12.9191 8.45059 12.9832 8.128 13.1977 7.9135L14.8007 6.3105C12.1674 5.20912 9.01606 5.7309 6.87348 7.87348C4.04217 10.7048 4.04217 15.2952 6.87348 18.1265C9.70478 20.9578 14.2952 20.9578 17.1265 18.1265C18.7727 16.4803 19.4622 14.2401 19.1935 12.0937C19.142 11.6827 19.4335 11.3078 19.8445 11.2563C20.2555 11.2049 20.6304 11.4963 20.6819 11.9073C21.0057 14.4934 20.1746 17.1997 18.1872 19.1872C14.7701 22.6043 9.2299 22.6043 5.81282 19.1872C2.39573 15.7701 2.39573 10.2299 5.81282 6.81282C8.55119 4.07444 12.6515 3.5312 15.9309 5.18028L17.4404 3.67086C17.6549 3.45637 17.9774 3.3922 18.2577 3.50828Z" />
  </svg>
);

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

type WorkspaceActionTooltipSide = "top" | "bottom" | "right";

const WORKSPACE_ACTION_TOOLTIP_GAP = 8;
const WORKSPACE_ACTION_TOOLTIP_VIEWPORT_MARGIN = 16;

export function WorkspaceActionTooltip({
  children,
  content,
  side = "top",
  compact = false,
  focusable = true,
  className,
}: {
  children: ReactNode;
  content?: ReactNode;
  side?: WorkspaceActionTooltipSide;
  compact?: boolean;
  focusable?: boolean;
  className?: string;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const showTooltip = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    if (!triggerRect || !tooltipRect) return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    if (side === "right") {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const halfHeight = tooltipRect.height / 2;
      const minTop = WORKSPACE_ACTION_TOOLTIP_VIEWPORT_MARGIN + halfHeight;
      setPosition({
        left: triggerRect.right + WORKSPACE_ACTION_TOOLTIP_GAP,
        top: Math.min(
          Math.max(triggerRect.top + triggerRect.height / 2, minTop),
          Math.max(minTop, viewportHeight - WORKSPACE_ACTION_TOOLTIP_VIEWPORT_MARGIN - halfHeight),
        ),
      });
      return;
    }
    const halfWidth = tooltipRect.width / 2;
    const centeredLeft = triggerRect.left + triggerRect.width / 2;
    const minLeft = WORKSPACE_ACTION_TOOLTIP_VIEWPORT_MARGIN + halfWidth;
    const maxLeft = Math.max(minLeft, viewportWidth - WORKSPACE_ACTION_TOOLTIP_VIEWPORT_MARGIN - halfWidth);

    setPosition({
      left: Math.min(Math.max(centeredLeft, minLeft), maxLeft),
      top: side === "bottom"
        ? triggerRect.bottom + WORKSPACE_ACTION_TOOLTIP_GAP
        : triggerRect.top - WORKSPACE_ACTION_TOOLTIP_GAP,
    });
  }, [side]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [content, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (content) return;
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer, content]);

  if (!content) return <>{children}</>;

  return (
    <span
      ref={triggerRef}
      className={cn(
        "inline-flex rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30",
        className,
      )}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={showTooltip}
      onMouseLeave={scheduleClose}
      onFocus={showTooltip}
      onBlur={scheduleClose}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
          return;
        }
        if (event.key !== "Escape") return;
        clearCloseTimer();
        setOpen(false);
      }}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className={cn(
                "pointer-events-auto fixed z-50 max-w-[calc(100vw-32px)] select-text",
                side === "right"
                  ? "lv-agent-rail-tooltip -translate-y-1/2"
                  : cn("-translate-x-1/2 rounded-md border border-[var(--border-subtle)] bg-white text-[11px] font-medium text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)]", compact ? "w-max px-2.5 py-1 leading-4" : "w-72 px-3 py-2 text-pretty leading-relaxed"),
                side === "top" && "-translate-y-full",
              )}
              style={{ left: position.left, top: position.top }}
              onMouseEnter={showTooltip}
              onMouseLeave={scheduleClose}
            >
              {content}
              {side !== "right" && <span
                aria-hidden="true"
                className={cn(
                  "absolute left-1/2 size-2 -translate-x-1/2 rotate-45 border-[var(--border-subtle)] bg-white",
                  side === "bottom"
                    ? "bottom-full translate-y-1/2 border-l border-t"
                    : "top-full -translate-y-1/2 border-b border-r",
                )}
              />}
            </span>,
            document.body,
          )
        : null}
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
    body: JSON.stringify(createDebugExecRequestBody(command)),
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

const DEFAULT_AGENT_SECTION: AgentSettingsSectionId = "chat";

const EXPLORE_SECTION_IDS = new Set<AgentSettingsSectionId>([
  "buddy", "memory", "achievement", "model", "diagnostics", "settings", "website", "deepseek-harness", "cloud-desktop",
  "terminal", "browser",
]);
const DAILY_SECTION_IDS = new Set<AgentSettingsSectionId>([
  "channel", "connectors", "skill", "automations", "chat",
]);

/** 跨整页刷新以外的场景保留每栏最近打开的页面，供顶部 Tab 返回。 */
let lastDailySection: AgentSettingsSectionId = "channel";
let lastExploreSection: AgentSettingsSectionId = "buddy";
let lastSidebarTab: "daily" | "explore" = "daily";
let pendingNewChatSessionBotId: string | null = null;

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
      {entries.map((entry, index) => (
        <div
          key={`${index}-${entry.slice(0, 24)}`}
          className="min-h-11 rounded-md border border-black/[0.06] bg-white px-3 py-3 text-sm leading-relaxed text-black/75 shadow-[0_1px_2px_rgba(15,23,42,0.02)]"
        >
          <p className="whitespace-pre-wrap break-words text-pretty">{entry}</p>
        </div>
      ))}
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
        description={t("查看当前 Hermes Agent 的持久记忆和用户画像文件")}
        actions={(
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-black/35 transition hover:text-black/80 disabled:cursor-not-allowed disabled:text-black/20"
            aria-label={t("刷新")}
            title={t("刷新")}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
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
              emptyText={activeTab === "memory" ? t("MEMORY.md 文件为空") : t("USER.md 文件为空")}
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
          <div className="mx-4 w-full max-w-[28rem] rounded-2xl border bg-white p-6 shadow-2xl" style={{ borderColor: "rgba(238,238,238,0.4)" }} onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("删除智能体")}</h3>
            </div>
            {/* 风险说明 */}
            <p className="rounded-xl border border-red-100 bg-red-50/70 px-3.5 py-3 text-sm leading-relaxed text-red-700" style={{ marginBottom: "6px" }}>
              <span className="block font-semibold">{t("风险提示：")}</span>
              <span className="mt-1 block">{t("删除后会话将立即断开，智能体的配置、已安装技能、记忆等相关数据将无法恢复。请谨慎操作！")}</span>
            </p>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              <span className="block">{t("已购买的套餐不受影响，不会因删除智能体而失效。")}</span>
              <span className="block">
                {t("如确认删除智能体，请输入名称")}{" "}
                <span className="select-all rounded-md bg-red-50 px-1.5 py-0.5 font-semibold text-red-600">
                  {bot.name}
                </span>
                。
              </span>
            </p>
            <input type="text" placeholder={t("请输入 {{name}}", { name: bot.name })} value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]" style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }} />
            {deleteErr && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteErr}</p>}
            {/* 按钮组：上下排列 */}
            <div className="flex flex-col gap-2">
              <button onClick={async () => { setDeleting(true); setDeleteErr(null); try { await deleteBot(bot.id); setShowDeleteConfirm(false); } catch (e) { setDeleteErr(e instanceof Error ? e.message : t("删除失败")); } finally { setDeleting(false); } }} disabled={deleteInput !== bot.name || deleting} className="w-full rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all" style={{ backgroundColor: deleteInput === bot.name && !deleting ? "#DC2626" : "#E5E7EB", cursor: deleteInput === bot.name && !deleting ? "pointer" : "not-allowed", fontSize: "16px" }}>
                {deleting ? t("删除中...") : t("我已知晓风险，确认删除")}
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

/* ─── Main Settings Page ─── */

const RESCUE_EXPORT_POLL_INTERVAL_MS = 5000;
const HERMES_WORKSPACE_EXPORT_PATH = "/home/agentuser/.hermes";
const RESCUE_EXPORT_TERMINAL_PHASES = new Set(["completed", "failed"]);
const TEA_SDK_SECTIONS = new Set<AgentSettingsSectionId>(["channel", "model"]);

/**
 * 会话是否可删除。
 *
 * 产品决策：默认会话（`chatId === ""`）不可删除。它是列表的兜底项——「新增会话」
 * 按钮位于 SDK 面板右上角，若允许把默认会话也删掉，用户可能删空列表，失去唯一
 * 的新增入口，无法再发起新会话。因此默认会话必须始终保留。
 *
 * 技术背景：`chatId === ""` 是 SDK 的合法默认会话标识（`resolveFallbackChatId`
 * 正是靠 `session.chatId === ""` 定位它）。SDK 1.4.1 的删除链路恰好也用 truthiness
 * 拦掉了空串（`deleteSession` / `deleteChat` 都是 `if (!chatId) return`），所以即便
 * 宿主不做这道判定，请求也不会发出。但这属于 SDK 的实现细节，不能作为产品契约
 * 依赖——宿主仍需显式守门，避免将来 SDK 修正 `!chatId` 后默认会话突然变为可删。
 */
const canDeleteSession = (session: LightVelaSession) => session.chatId !== "";

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

function AgentSettingsDataLoading({ multiBotEnabled, isChat, collapsed }: { multiBotEnabled: boolean; isChat: boolean; collapsed: boolean }) {
  return <AgentSettingsLoadingContent multiBotEnabled={multiBotEnabled} isChat={isChat} collapsed={collapsed} />;
}

const isRescueExportRunning = (status: WorkerActionStatusResult | null | undefined) => {
  if (!status) return false;
  return !RESCUE_EXPORT_TERMINAL_PHASES.has(status.phase);
};

type AgentSettingsPageProps = {
  /** Native shell owns navigation; reuse existing section controllers. */
  embedded?: boolean;
  consoleHost?: AgentConsoleHostPort;
  presentationActive?: boolean;
  createRequestId?: number;
  onCreateRequestHandled?: () => void;
  deleteRequestId?: number;
  deleteRequestBotId?: string;
  onDeleteRequestHandled?: () => void;
  initialSectionSlug?: string;
  sectionId?: AgentSettingsSectionId;
} & ({ showHeader?: true; sidebarCollapsed?: never } | { showHeader: false; sidebarCollapsed?: boolean });

export const AgentSettingsPage = ({
  initialSectionSlug,
  sectionId,
  showHeader = true,
  sidebarCollapsed,
  embedded = false,
  consoleHost,
  presentationActive = true,
  createRequestId = 0,
  onCreateRequestHandled,
  deleteRequestId = 0,
  deleteRequestBotId,
  onDeleteRequestHandled,
}: AgentSettingsPageProps = {}) => {
  const t = useT();
  const localSidebar = useAgentSidebarCollapse(sidebarCollapsed === undefined);
  const isSidebarCollapsed = sidebarCollapsed ?? localSidebar.collapsed;
  const locale = useCurrentLocale();
  const isDesktop = useIsDesktop();
  const navigate = useAppNavigate();
  const { pathname } = useAppLocation();
  const [searchParams] = useAppSearchParams();
  const creatingParam = searchParams.get("creating")?.trim() ?? "";
  const requestedBotId = searchParams.get(AGENT_BOT_QUERY_KEY)?.trim() ?? "";
  const requestedCreatingBotId = creatingParam && creatingParam !== "true" ? creatingParam : "";
  /* 订阅成功后引导「为首个 Bot 命名」的意图（/agents?create=1），区别于 creating 的等待态。 */
  const createBotIntentParam = searchParams.get(AGENT_CREATE_QUERY_KEY)?.trim() ?? "";
  const createBotPageParam = searchParams.get(AGENT_CREATE_PAGE_QUERY_KEY) === "1";
  const firstCreateEntryHandled = useRef(false);
  const { bots, botsLoading, hasResolvedBots, deleteBot, user, refreshBots, refreshPasses, isSubscribed, addBot, activePass, modifyingPass, passUpgradeFailed, passesLoading, passesError, returningUpgrade, passUpgradePaused, passUpgradeRefreshing, retryPassUpgrade } = useOpenClaw();
  const upgradingPass = modifyingPass ?? (activePass?.status === "modifying" ? activePass : null);
  const isModifying = Boolean(upgradingPass) || returningUpgrade || passUpgradePaused;
  const repositories = useRepositories();
  const paidBillingEnabled = usePaidBillingEnabled();
  const multiBotEnabled = useMultiBotEnabled();
  const cloudDesktopEnabled = useCloudDesktopEnabled();
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  const paidBillingActive = isPaidBillingEnabled(paidBillingEnabled);
  const renewalAvailable = isRenewalAvailableForRegion(isGlobal, paidBillingActive);
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
  const [createBotName, setCreateBotName] = useState("");
  const [createBotMode, setCreateBotMode] = useState<"clone-current" | "clone-main" | "blank">("blank");
  const visibleBots = useMemo(
    () => bots.filter((bot) => (
      bot.status !== "provisioning"
      && bot.status !== "deleting"
      && (multiBotEnabled || bot.isDefault)
    )),
    [bots, multiBotEnabled],
  );
  const createLimitMessage = useMemo(
    () => getOpenClawCreateLimitMessage(bots, user.plan.maxBots, (message) => t(message)),
    [bots, t, user.plan.maxBots],
  );
  const [showHiddenAgentTools, setShowHiddenAgentTools] = useState(false);
  const openCraftChatEnabled = true;
  /** 多 bot 创建引导（取代原先的「创建 Bot」弹窗） */
  const [showMultiBotOnboarding, setShowMultiBotOnboarding] = useState(false);
  const createBotPageHistoryRef = useRef(false);
  useEffect(() => {
    if (createBotPageParam && IS_BUDDY_ONBOARDING_ENABLED) {
      createBotPageHistoryRef.current = true;
      setShowMultiBotOnboarding(true);
    } else if (createBotPageHistoryRef.current) {
      createBotPageHistoryRef.current = false;
      setShowMultiBotOnboarding(false);
    }
  }, [createBotPageParam]);
  /** 「从其他 Bot 复制」选中的来源 bot id */
  const [cloneSourceBotId, setCloneSourceBotId] = useState("");

  /**
   * 可作为复制来源的 bot。
   *
   * 用 visibleBots 而不是 bots：provisioning / deleting 的实例沙箱还没就绪
   * （或正在销毁），拿它做 clone 源会失败。主 bot 排最前并打角标 —— 它配置
   * 最全，是多数人想复制的那个。
   */
  const cloneSourceChoices = useMemo(
    () => [...visibleBots]
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      .map((bot) => ({
        id: bot.id,
        label: resolveAgentDisplayName(bot.name, t),
        isDefault: Boolean(bot.isDefault),
      })),
    [visibleBots, t],
  );
  const [consoleShowStateReady, setConsoleShowStateReady] = useState(false);
  const { canCreateInitialAgent, canCreateAdditionalBot } = resolveOpenClawCreatePermissions(
    multiBotEnabled,
    createLimitMessage,
  );
  const provisioningBot = useMemo(() => {
    if (isModifying) return null;
    if (requestedCreatingBotId) {
      return bots.find((bot) => bot.id === requestedCreatingBotId && bot.status === "provisioning") ?? null;
    }
    return bots.find((bot) => bot.status === "provisioning") ?? null;
  }, [bots, requestedCreatingBotId, isModifying]);
  const completedCreatingBot = useMemo(
    () => findCompletedCreatingBot(visibleBots, requestedCreatingBotId),
    [visibleBots, requestedCreatingBotId],
  );
  /* 实例内部的子页面切换：由 Next /agents/<section> 路由在服务端校验，client 只接收已归一化 sectionId。 */
  const requestedSection = sectionId ?? DEFAULT_AGENT_SECTION;
  const activeSection = requestedSection === "overview" ? DEFAULT_AGENT_SECTION : requestedSection;
  const isEmptyAgentPage = !isModifying
    && !passesLoading && !isCreating && !botsLoading && visibleBots.length === 0;

  /* Tab 切换 */
  const [activeTabId, setActiveTabId] = useState((requestedBotId || visibleBots[0]?.id || requestedCreatingBotId) || "creating");
  const activeBot = isModifying ? undefined : visibleBots.find((bot) => bot.id === activeTabId) ?? visibleBots[0];
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [botRailProfileRevision, setBotRailProfileRevision] = useState(0);
  const [renewPassModalOpen, setRenewPassModalOpen] = useState(false);

  /* ── 配置引导：未写过 SOUL.md 的新订阅用户，主区展示配置表单，
     侧边栏只留「个性化你的智能伙伴」，其余入口置灰不可点。 ── */
  const { needsOnboardingByQuery, completeOnboarding } = useDemoOnboarding();

  /* ── 侧边栏「日常/探索」双 tab 与多会话受控状态 ── */
  /** tab 仅切侧边栏内容，右侧主区始终按当前路由渲染；初始值随路由推导，不做持久化。 */
  const [sidebarTab, setSidebarTab] = useState<"daily" | "explore">(
    EXPLORE_SECTION_IDS.has(activeSection) ? "explore" : DAILY_SECTION_IDS.has(activeSection) ? "daily" : lastSidebarTab,
  );
  const [chatSessionsExpanded, setChatSessionsExpanded] = useState(true);
  const [mobileChatNavOpen, setMobileChatNavOpen] = useState(false);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileChatNavOpen || isDesktop) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileNavCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileChatNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      mobileNavTriggerRef.current?.focus();
    };
  }, [isDesktop, mobileChatNavOpen]);
  useEffect(() => {
    if (isDesktop) setMobileChatNavOpen(false);
  }, [isDesktop]);
  /**
   * 连接器入口默认隐藏（灰度）：控制台执行 show() 后显示（与工作台 reveal
   * 同款机制——window.show 劫持 toggle 持久化状态并广播）。初始读持久化值
   * （show 过的用户刷新后保持显示），订阅跟随开关（再次 show 收起）。
   * 且仅国内站显示（国际站走独立计费体系，连接器域名后续单独接入）。
   */
  const [connectorsRevealed, setConnectorsRevealed] = useState(() => isConsoleShowEnabled());
  useEffect(() => subscribeConsoleShow(setConnectorsRevealed), []);
  const showConnectorsEntry = connectorsRevealed && !isGlobal;
  const sidebarSessionBotKey = openCraftChatEnabled && activeBot && accountId
    ? JSON.stringify([accountId, activeBot.instanceId ?? activeBot.id, activeBot.profileId ?? "main", isGlobal])
    : null;
  const sidebarSessionBotKeyRef = useRef(sidebarSessionBotKey);
  sidebarSessionBotKeyRef.current = sidebarSessionBotKey;
  const {
    sessions: chatSessions,
    loading: chatSessionsLoading,
    onSessionStateChange: applyChatSessionState,
  } = useAgentSidebarSessionList(sidebarSessionBotKey);
  const { unreadChatIds, setUnread } = useAgentSidebarUnreadSessions(sidebarSessionBotKey);
  const emptyChatSessionState = resolveAgentSidebarEmptySessionState({
    botPaused: activeBot?.status === "paused",
    loading: chatSessionsLoading,
    botKey: sidebarSessionBotKey,
    sessionCount: chatSessions.length,
  });
  const [chatSessionsHasMore, setChatSessionsHasMore] = useState(false);
  const [chatPinSupported, setChatPinSupported] = useState(false);
  const [pinningChatIds, setPinningChatIds] = useState<ReadonlySet<string>>(() => new Set());
  const [chatPinError, setChatPinError] = useState<string | null>(null);
  const [chatSessionMutationState, setChatSessionMutationState] = useState<EmbeddedSessionMutationState | null>(null);
  const [chatSessionCommands, setChatSessionCommands] = useState<EmbeddedSessionCommands | null>(null);
  const chatSessionPagination = useAgentSessionPagination(
    chatSessions,
    chatSessionsHasMore,
    chatSessionCommands?.loadMoreSessions,
    isGlobal ? 20 : 5,
  );
  /** 宿主持有的选中会话（受控值）；undefined 表示尚未指定。 */
  const [selectedChatId, setSelectedChatId] = useState<string | undefined>(undefined);
  const lastVisibleChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    const visibleChatId = activeSection === "chat" ? selectedChatId ?? null : null;
    if (visibleChatId !== null && lastVisibleChatIdRef.current !== visibleChatId) {
      setUnread(visibleChatId, false);
    }
    lastVisibleChatIdRef.current = visibleChatId;
  }, [activeSection, selectedChatId, setUnread]);
  /** 内嵌会话动作句柄（renameSession / deleteSession）。 */
  const [chatSessionActions, setChatSessionActions] = useState<LightVelaSessionActions | null>(null);
  /** 行内重命名状态：renamingChatId 非空表示该项处于编辑态。 */
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState("");
  /** 三点菜单当前展开的会话。 */
  const [openSessionMenuChatId, setOpenSessionMenuChatId] = useState<string | null>(null);
  /** 待删除会话（非空表示弹出删除二次确认）。 */
  const [sessionToDelete, setSessionToDelete] = useState<LightVelaSession | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  /** 路由切换后记住各栏最近使用的页面；控制台常驻不重挂载，侧栏 tab 也随路由同步。 */
  useEffect(() => {
    if (EXPLORE_SECTION_IDS.has(activeSection)) {
      lastExploreSection = activeSection;
      lastSidebarTab = "explore";
      setSidebarTab("explore");
    } else if (DAILY_SECTION_IDS.has(activeSection)) {
      lastDailySection = activeSection;
      lastSidebarTab = "daily";
      setSidebarTab("daily");
    }
  }, [activeSection]);

  const handleSidebarExploreTabClick = () => {
    if (showBuddyOnboarding) return;
    setSidebarTab("explore");
    lastSidebarTab = "explore";
    if (!EXPLORE_SECTION_IDS.has(activeSection)) {
      navigate(getAgentSectionHref(AGENT_SECTION_PATH_BY_ID[lastExploreSection], searchParams));
    }
  };

  const handleSidebarDailyTabClick = () => {
    setSidebarTab("daily");
    lastSidebarTab = "daily";
    if (!DAILY_SECTION_IDS.has(activeSection)) {
      const target = lastDailySection === "chat" && !isActiveBotChatAvailable ? "channel" : lastDailySection;
      navigate(getAgentSectionHref(AGENT_SECTION_PATH_BY_ID[target], searchParams));
    }
  };

  /** 保持内嵌会话回调引用稳定，避免选中会话变化时重置动作句柄。 */
  const applyChatSelectedChatId = useCallback<
    NonNullable<LightVelaMultiSessionOptions["onSelectedChatIdChange"]>
  >((chatId) => {
    // 收到值必须无条件写回，否则受控状态与内嵌会话失步。
    // 不要在此加真值守卫——空串是合法默认会话，会被误当成"无效值"丢弃。
    setSelectedChatId(chatId);
  }, []);

  const applyChatSessionActions = useCallback<
    NonNullable<LightVelaMultiSessionOptions["onSessionActionsChange"]>
  >((actions) => {
    setChatSessionActions(actions);
  }, []);

  const openCraftChatMultiSessionBridge = useMemo<LightVelaMultiSessionOptions>(
    () => ({
      selectedChatId,
      onSessionStateChange: applyChatSessionState,
      onSelectedChatIdChange: applyChatSelectedChatId,
      onSessionActionsChange: applyChatSessionActions,
    }),
    [selectedChatId, applyChatSessionState, applyChatSelectedChatId, applyChatSessionActions],
  );

  const createChatSession = () => {
    if (chatSessionCommands === null || chatSessionMutationState?.pending === true) return;
    const previousSelection = selectedChatId;
    setOpenSessionMenuChatId(null);
    setRenamingChatId(null);
    setSessionToDelete(null);
    setSelectedChatId("");
    void chatSessionCommands.createSession().catch(() => {
      setSelectedChatId((current) => current === "" ? previousSelection : current);
    });
  };

  const startSessionRename = (session: LightVelaSession) => {
    setOpenSessionMenuChatId(null);
    setRenamingChatId(session.chatId);
    setRenamingDraft(session.title || "");
  };

  const markSessionUnread = (chatId: string) => {
    setUnread(chatId, true);
    setOpenSessionMenuChatId(null);
  };

  const toggleSessionPin = (session: LightVelaSession) => {
    const commands = chatSessionCommands;
    if (session.chatId === "" || !chatPinSupported || commands === null || pinningChatIds.has(session.chatId)) return;
    const pinned = "pinned" in session && session.pinned === true;
    const botKey = sidebarSessionBotKey;
    setOpenSessionMenuChatId(null);
    setChatPinError(null);
    setPinningChatIds((current) => new Set(current).add(session.chatId));
    void runBotScopedSessionPin(
      () => commands.setPinned(session.chatId, !pinned),
      () => sidebarSessionBotKeyRef.current === botKey,
      () => setChatPinError(session.chatId),
      () => setPinningChatIds((current) => {
        const next = new Set(current);
        next.delete(session.chatId);
        return next;
      }),
    );
  };

  const commitSessionRename = () => {
    const chatId = renamingChatId;
    if (chatId == null) return;
    const nextTitle = renamingDraft.trim();
    setRenamingChatId(null);
    setRenamingDraft("");
    if (nextTitle) chatSessionActions?.renameSession(chatId, nextTitle);
  };

  const cancelSessionRename = () => {
    setRenamingChatId(null);
    setRenamingDraft("");
  };

  const openSessionDeleteConfirm = (session: LightVelaSession) => {
    if (!canDeleteSession(session)) return;
    setOpenSessionMenuChatId(null);
    setSessionToDelete(session);
  };

  const confirmSessionDelete = () => {
    if (!sessionToDelete) return;
    // 再次守门：SDK 会静默丢弃 chatId === "" 的删除（见 canDeleteSession 注释），
    // 这里挡住可避免「弹窗关了但会话还在」的假成功。
    if (!canDeleteSession(sessionToDelete)) {
      setSessionToDelete(null);
      return;
    }
    chatSessionActions?.deleteSession(sessionToDelete.chatId);
    setSessionToDelete(null);
  };

  const cancelSessionDelete = () => {
    setSessionToDelete(null);
  };

  useEffect(() => {
    // chatId === "" 是合法默认会话，判定只能用 == null（SDK 对接注意事项 1）。
    // 用 truthiness 会让默认会话的菜单打开后无法通过点击外部 / Esc 关闭。
    if (openSessionMenuChatId == null) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) {
        setOpenSessionMenuChatId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSessionMenuChatId(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openSessionMenuChatId]);

  // bots 异步加载完成或 URL 变化时同步选择；避免其他本地状态变化
  // 重跑旧 ?bot= 参数，并覆盖正在进行的 Bot 切换。
  useEffect(() => {
    if (isCreating) return;
    if (requestedBotId && visibleBots.some((bot) => bot.id === requestedBotId)) {
      setActiveTabId(requestedBotId);
      return;
    }
    if (visibleBots.length > 0) {
      setActiveTabId((currentId) => visibleBots.some((bot) => bot.id === currentId)
        ? currentId
        : (visibleBots.find((bot) => hasUnfinishedBuddySetup(bot.id)) ?? visibleBots[0])!.id);
    }
  }, [visibleBots, isCreating, requestedBotId]);
  const defaultBot = visibleBots.find((bot) => bot.isDefault) ?? visibleBots[0];
  const isActiveBotDefault = Boolean(activeBot && defaultBot && activeBot.id === defaultBot.id);

  useEffect(() => {
    if (activeSection !== "chat" || chatSessionCommands === null || pendingNewChatSessionBotId !== activeBot?.id) return;
    pendingNewChatSessionBotId = null;
    createChatSession();
  }, [activeSection, activeBot?.id, chatSessionCommands]);

  useEffect(() => {
    if (activeSection !== "chat") pendingNewChatSessionBotId = null;
  }, [activeSection]);

  /*
   * 智能伙伴资料：统一从真实 SOUL.md 读，资料卡与侧边栏同源。
   * 名字回落 activeBot.name，保证 SOUL 还没写时两处显示一致。
   */
  const buddyProfileState = useBuddyProfile({
    botId: activeBot?.id,
    profileId: activeBot?.profileId,
    fallbackName: activeBot ? resolveAgentDisplayName(activeBot.name, t) : "",
    exec: repositories.bots.execDebugCommand,
  });


  /*
   * 配置引导只对「新订阅用户」生效。
   *
   * 判定 = 刚走完 ?creating= 流程（sessionStorage 标记）且 SOUL.md 尚未写过。
   * 只看「SOUL 不存在」会把从没配过人设的老用户也拉进引导，所以必须叠加新用户标记。
   * `?onboarding=1` 可强制进入，便于演示与回归。
   */
  /*
   * 配置引导只对「新订阅用户」生效。
   *
   * 判定 = 刚走完 ?creating= 流程（sessionStorage 标记）+ 还没走过本引导。
   *
   * 「还没走过」不能用「SOUL.md 不存在」判断 —— 后端建 bot 时会写一个默认
   * SOUL.md，那样判定永远不成立。改看 SOUL 里有没有 `LightVela-Avatar`
   * 自定义字段，只有走过本引导才会写入。
   * hasBuddyConfig 为 null（沙箱还没读到）时也放行：有新用户标记就该引导，
   * 老用户没有标记，不受影响。
   */
  /*
   * 引导完成后立刻收起表单。
   *
   * 不能只依赖 clearPendingOnboarding —— sessionStorage 的变更不会触发重渲染，
   * hasBuddyConfig 的刷新又是异步的，中间这段时间引导会闪回。
   */
  const [onboardingJustFinished, setOnboardingJustFinished] = useState(false);
  /**
   * 引导面板是否已进入配置阶段（用户点了「创建」）。
   *
   * 订阅路径下实例是后端随订阅建好的，进页面时就已经是 running。下面那个
   * 「实例已就绪 → 退出 loading」的兜底 effect 因此会立刻把 isCreating 置
   * false，showEarlyOnboarding 随之变 false，引导面板被卸载 —— 用户点完模板
   * 瞬间被弹回表单，人设/技能/定时任务一步都没跑。
   *
   * 有了这个标记，配置期间就不退出 loading，等 onCreated 再走正常收尾。
   */


  const isActiveBotPendingOnboarding = isPendingOnboarding(activeBot?.id)
    || isPendingOnboarding(activeBot?.instanceId);

  /*
   * 创建期前置引导 —— 省掉「等实例」那次咖啡杯。
   *
   * 原流程：点创建 → 咖啡杯干等实例 provisioning → 实例就绪 → 才进引导表单。
   * 现流程：点创建 → 直接进引导表单，填资料与实例创建并行。
   *
   * 安全性：表单阶段不碰沙箱；用户点「创建」后 AgentOnboardingPanel 会先
   * waitForSandbox 轮询到实例可执行命令才写配置，不会写到半成品实例上。
   *
   * provisioning 的实例被 visibleBots 过滤掉了（activeBot 为空），所以 botId
   * 只能从 URL 的 ?creating= 或 provisioningBot 取。
   *
   * 创建失败时不抢错误态 —— 必须让用户看到实例没建起来。
   */
  const earlyOnboardingBotId = requestedCreatingBotId || provisioningBot?.id || "";
  /*
   * 目标 profile。
   *
   * 不能回落 "main" —— 那是主 bot 的 profile 根目录（~/.hermes，不带
   * profiles/ 子路径）。bots 列表未就绪时 provisioningBot 为 null，一旦
   * 回落就会把新 bot 的人设、描述、头像写进主 bot，多 bot 场景下是串写。
   * 空串表示「还不知道」，由引导面板等到位再写（见 waitForProfileId）。
   */
  const earlyOnboardingProfileId = resolveOnboardingProfileId(bots, earlyOnboardingBotId);
  const showEarlyOnboarding = shouldShowEarlyOnboarding({
    isCreating,
    isModifying,
    hasCreationError: Boolean(creationError),
    onboardingJustFinished,
  });

  /*
   * 侧边栏这一帧到底存不存在。
   *
   * 侧边栏渲染在 `!isCreating && activeBot && sdkInstance` 分支里，而
   * lv-agent-sidebar-header / -main / -shell 这三个 class 是给它让位用的。
   * 两者必须同时成立，否则会出现「class 占了 264px 但侧边栏没渲染」的空白竖条。
   *
   * 不能只看 showEarlyOnboarding：从 hero 进来时 URL 不带 `?creating=`，
   * isCreating 初值是 false，要等 bots 拉完发现 provisioningBot 才转 true。
   * 这段窗口里 showEarlyOnboarding 仍是 false，但 activeBot 也还没有
   * （provisioning 的实例被 visibleBots 过滤掉），侧边栏同样不存在 —— 
   * 这正是「首次进入左侧空白、刷新后才正常」的原因。
   *
   * 所以直接按侧边栏自身的渲染条件判断，与加载时序无关。
   * （sdkInstance 是 activeBot 的派生值，且定义在本行之后，这里只看 activeBot。）
   */

  /*
   * 配置写到一半刷新过。
   *
   * 必须单列一条放行条件：hasBuddyConfig 看的是「有没有写过头像」，而头像
   * 在第 2 步（profile-meta）就落盘了。在那之后刷新，hasBuddyConfig 已经是
   * true，下面那条 isActiveBotPendingOnboarding 的判定不成立 —— 引导直接
   * 不再出现，可技能和定时任务根本没装，用户以为建好了，界面毫无提示。
   *
   * 有未完成快照时强制把引导打开，面板挂载后会自己接着上次的进度跑完。
   */
  const hasUnfinishedBuddySetupForBot = hasUnfinishedBuddySetup(activeBot?.id);

  const showBuddyOnboarding = IS_BUDDY_ONBOARDING_ENABLED
    && Boolean(activeBot)
    && !isModifying
    && !isCreating
    && !onboardingJustFinished
    && (needsOnboardingByQuery
      || hasUnfinishedBuddySetupForBot
      || (isActiveBotPendingOnboarding && buddyProfileState.hasBuddyConfig !== true));

  /*
   * 侧边栏这一帧到底存不存在（决定那三个让位 class 是否套用）。
   *
   * 三种情况没有侧边栏：
   *   - isCreating / 没有 activeBot —— 侧边栏本身不渲染
   *   - 任一引导态 —— 引导页要全屏居中，左侧导航要等配置完成后才出现，
   *     否则新用户一进来就面对一堆点不了的入口
   */
  const hasSidebarLayout = hasAgentSidebarLayout({
    isCreating,
    hasActiveBot: Boolean(activeBot),
  }) && !showBuddyOnboarding && !showMultiBotOnboarding;
  const entryRedirectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasResolvedBots || isCreating || isModifying || showEarlyOnboarding || showBuddyOnboarding || showMultiBotOnboarding || createBotIntentParam || createBotPageParam) return;
    if (requestedSection !== "overview" && sectionId) {
      entryRedirectRef.current = null;
      return;
    }
    const botId = visibleBots.some((bot) => bot.id === requestedBotId) ? requestedBotId : activeBot?.id;
    if (!botId) return;
    const destination = getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.chat, botId);
    const redirectKey = `${pathname}:${destination}`;
    if (entryRedirectRef.current === redirectKey) return;
    entryRedirectRef.current = redirectKey;
    pendingNewChatSessionBotId = botId;
    navigate(destination, { replace: true });
  }, [requestedSection, sectionId, hasResolvedBots, isCreating, isModifying, showEarlyOnboarding, showBuddyOnboarding, showMultiBotOnboarding, createBotIntentParam, createBotPageParam, visibleBots, requestedBotId, activeBot?.id, pathname, navigate]);
  const useMobileChatLayout = activeSection === "chat" && openCraftChatEnabled && hasSidebarLayout;
  const chatPageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!useMobileChatLayout || !chatPageRef.current) return;
    return bindChatVisualViewportHeight(chatPageRef.current);
  }, [useMobileChatLayout]);
  useEffect(() => {
    setMobileChatNavOpen(false);
  }, [activeSection, activeBot?.id]);

  /*
   * 把「正在走创建引导」标到 <html> 上，供 CSS 去掉 header 的线框。
   *
   * 为什么绕这一圈：这条路由的 header 由 next-site/agents-page-client.tsx
   * 渲染（本组件收到的是 showHeader={false}），那是个路由层组件，拿不到
   * 引导状态；而引导状态只有这里知道。用一个根节点 class 把信号传出去，
   * 是本项目既有做法（见上面的 lw-settings-scrollbar-stable，以及
   * maintenance-announcement-banner 的 lw-has-announcement）。
   *
   * 三个引导标记都要算：
   *   - showEarlyOnboarding  订阅后的创建期前置引导
   *   - showBuddyOnboarding  首个 bot 的引导
   *   - showMultiBotOnboarding  从已有 bot 新建
   * 漏掉任何一个，那条路径下 logo 还是会被框住。
   */
  const isOnboardingVisible = showEarlyOnboarding
    || showBuddyOnboarding
    || showMultiBotOnboarding;

  /*
   * 引导一旦渲染出来，就锁住创建态，不再让那几个「实例已就绪」的 effect
   * 改 URL / 关 loading。
   *
   * 为什么不靠 onSetupStart（点「创建」时才报）：面板在用户**点模板卡片**
   * 时就已经被卸载了 —— 那一刻还没进配置阶段，回调根本来不及触发。真实
   * 表现是点了模板毫无反应（弹窗开了又随组件一起消失），或直接回到表单。
   *
   * 用 ref 而不是 state：它只需要被 effect 读，不需要触发重渲染；而且要能
   * 在同一帧内立刻生效，setState 的异步批处理会留出一帧窗口让 effect 抢跑。
   */
  const onboardingLockRef = useRef(false);
  if (isOnboardingVisible) onboardingLockRef.current = true;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("lv-agent-onboarding", isOnboardingVisible);
    return () => {
      root.classList.remove("lv-agent-onboarding");
    };
  }, [isOnboardingVisible]);

  /** 引导完成：立刻收起表单，再刷新资料与列表 */
  const handleBuddyCreated = useCallback((createdBotId?: string) => {
    setOnboardingJustFinished(true);
    /*
     * 配置已结束，放开那三个会退出创建态 / 改 URL 的 effect。
     *
     * 不复位的话锁会一直留着：同一次会话里后续再进创建态时，兜底、轮询与
     * URL 改写全被挡住，实例失败或被删也不会退出 loading。
     *
     * 复位安全：上一行的 setOnboardingJustFinished(true) 会让
     * showEarlyOnboarding 转 false（见 shouldShowEarlyOnboarding），
     * 引导随即不可见，所以「引导可见就加锁」那行不会立刻把它又置回 true。
     */
    onboardingLockRef.current = false;
    completeOnboarding();
    if (activeBot) {
      // 打标时可能用的是 instanceId，两个都清
      clearPendingOnboarding(activeBot.id);
      if (activeBot.instanceId) clearPendingOnboarding(activeBot.instanceId);
    }
    // 创建期引导走的是 URL 上的 botId，此时 activeBot 还不存在（实例仍
    // provisioning），不清这个打标会导致实例就绪后又弹一次引导。
    if (earlyOnboardingBotId) clearPendingOnboarding(earlyOnboardingBotId);

    /*
     * 切到刚创建的那个 bot。
     *
     * 不切的话 activeTabId 还指着创建前那个 bot，用户配置完会停在旧 bot 的
     * 对话页上，看不到自己刚建的东西。
     *
     * 这里同时写 activeTabId 和 URL 的 ?bot=：
     *   - 新 bot 此刻多半还在 provisioning，会被 visibleBots 过滤掉，光设
     *     activeTabId 会被那条「指向的 bot 不在列表里就回落第一个」的兜底
     *     逻辑改回去；
     *   - 而 requestedBotId（URL）优先级更高，等 refreshBots 把新 bot 带进
     *     列表后，它会自动把 activeTabId 拉到新 bot 上。
     */
    if (createdBotId) {
      pendingNewChatSessionBotId = createdBotId;
      setActiveTabId(createdBotId);
      setSidebarTab("daily");
      navigate(
        getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.chat, createdBotId),
        { replace: true },
      );
    }

    buddyProfileState.reload();
    void refreshBots();
  }, [completeOnboarding, activeBot, earlyOnboardingBotId, buddyProfileState, refreshBots, navigate]);

  const isActiveBotChatAvailable = openCraftChatEnabled;
  const isFirstBotCreation = !activeBot;
  const remainingInstanceBotCount = activeBot
    ? bots.filter((bot) => (
      bot.id !== activeBot.id
      && (bot.instanceId ?? bot.id) === (activeBot.instanceId ?? activeBot.id)
    )).length
    : 0;

  useEffect(() => {
    if (!consoleShowStateReady || activeSection !== "chat" || !activeBot || isActiveBotChatAvailable) return;
    setSidebarTab("daily");
    navigate(getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.channel, activeBot.id), { replace: true });
  }, [activeBot?.id, activeSection, consoleShowStateReady, isActiveBotChatAvailable, navigate]);

  const weixinOccupiedByOther = Boolean(
    activeBot?.weixinOwner && activeBot.weixinOwner.botId !== activeBot.id,
  );
  const whatsAppOccupiedByOther = Boolean(
    activeBot?.whatsAppOwner && activeBot.whatsAppOwner.botId !== activeBot.id,
  );
  const prepareBotSwitch = (botId: string) => {
    if (botId === activeBot?.id) return;
    pendingNewChatSessionBotId = botId;
    setActiveTabId(botId);
    setChatSessionCommands(null);
    setSelectedChatId(undefined);
    setOpenSessionMenuChatId(null);
    setSidebarTab("daily");
    setChatSessionsExpanded(true);
    setMobileChatNavOpen(false);
  };
  const handleSelectBot = (botId: string) => {
    prepareBotSwitch(botId);
    navigate(getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.chat, botId), { replace: true });
  };
  const activeBotStatus = activeBot?.status;
  const activeBotId = activeBot?.id;
  const activeRuntimeInstanceId = activeBot?.instanceId ?? activeBotId;
  const passExpiryReminder = useMemo(
    () => (isGlobal || paidBillingActive ? getPassExpiryReminder(activePass) : null),
    [activePass, paidBillingActive],
  );
  const passExpiryReminderCopy = passExpiryReminder ? getPassExpiryReminderCopy(passExpiryReminder, t) : null;
  const passExpiryTooltipId = useId();
  /** 「对话」入口禁用条件：对话不可用（含调试入口规则）或尚未创建个人助手（新手引导）。 */
  const isChatTabDisabled = !isActiveBotChatAvailable || showBuddyOnboarding;
  const handleRenewPassSuccess = useCallback(async () => {
    setRenewPassModalOpen(false);
    await refreshPasses();
  }, [refreshPasses]);
  const shouldShowDataLoading = shouldShowAgentSettingsDataLoading({
    botsLoading,
    passesLoading,
    isCreating,
    visibleBotCount: visibleBots.length,
  });

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
      const snapshot = await fetchHermesMemorySnapshot(repositories.bots, requestedBotId, activeBot?.profileId);
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
  }, [activeBot?.profileId, activeBotId, activeBotStatus, repositories]);

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
        profileId: activeBot?.profileId,
        target,
        value,
        existingChars,
        getGatewayRestartCommand: async () => {
          return (await getHermesScriptCommands(activeBot?.profileId)).getGatewayRestartCommand();
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
   * channel / model 配置面板（agent-config 的 ChannelPanel / ModelPanel）
   * 使用的命令执行器。
   *
   * 走本地 `createLocalCommandExecutor`，直连 `POST /v1/instances/:botId/debug/exec`
   * （国际站由后端建立 TAT PtyExecCmdStream，国内站保持原 envd 执行链路），
   * 与 chat / skill / diagnostics 面板同一条「直连」链路，彻底脱离 SDK 的
   * TAT 两步式（RunCommand → 轮询 getInvocationTask）逻辑。
   *
   * `sdkCommandLifecycle` 挂载业务钩子（自动化模型切换同步、QQ 群策略注入）。
   * 仅在 activeBot 存在时构造；无 bot 时传 undefined，面板内部 fallback 到空
   * executor 占位（实际操作路径不会触发）。
   */
  const teaSdkCommandExecutor = useMemo<ICommandExecutor | undefined>(
    () => {
      if (!activeBotId) return undefined;
      const executor = createLocalCommandExecutor({
        repositories,
        botId: activeBotId,
        commandLifecycle: sdkCommandLifecycle,
      });
      const runWithUniqueChannelBinding = async <T extends { success: boolean }>(
        command: string,
        run: () => Promise<T>,
      ): Promise<T> => {
        const channel = /--platform\s+'?(weixin|whatsapp)'?(?:\s|$)/.exec(command)?.[1] as "weixin" | "whatsapp" | undefined;
        const isConnect = Boolean(channel && /acli gateway qr-url\b/.test(command));
        const isDelete = Boolean(channel && /acli channel delete\b/.test(command));
        // Always consult CTL: a cached connected owner does not prove that its
        // on-disk session is still present or that another scan is not reserved.
        const shouldClaim = isConnect;
        const reservationId = shouldClaim && channel ? await repositories.bots.claimUniqueChannel(activeBotId, channel) : undefined;
        try {
          const result = await run();
          if (shouldClaim && channel && !result.success && (channel === "weixin" || reservationId)) {
            await repositories.bots.releaseUniqueChannel(activeBotId, channel, reservationId).catch(() => undefined);
          }
          if (isDelete && channel && result.success) {
            await repositories.bots.releaseUniqueChannel(activeBotId, channel);
          }
          if (shouldClaim && channel && result.success && (channel === "weixin" || reservationId)) {
            await repositories.bots.confirmUniqueChannel(activeBotId, channel, reservationId);
          }
          if ((isConnect || isDelete) && result.success) await refreshBots();
          return result;
        } catch (error) {
          if (shouldClaim && channel && (channel === "weixin" || reservationId)) {
            await repositories.bots.releaseUniqueChannel(activeBotId, channel, reservationId).catch(() => undefined);
          }
          throw error;
        }
      };
      return {
        run: (options) => runWithUniqueChannelBinding(options.command, () => executor.run(options)),
        runWithProgress: (options) => runWithUniqueChannelBinding(options.command, () => executor.runWithProgress(options)),
      };
    },
    [repositories, activeBotId, refreshBots, sdkCommandLifecycle],
  );

  /* 删除相关 */
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingBot, setDeletingBot] = useState(false);
  const [deleteTargetBot, setDeleteTargetBot] = useState<OpenClawBot | null>(null);
  const deleteDialogBot = deleteTargetBot ?? activeBot;
  const [repairingBotIds, setRepairingBotIds] = useState<Set<string>>(new Set());
  const consumedDeleteRequest = useRef(0);

  const handleRetryBot = async () => {
    if (!activeBot || activeBot.status !== "failed") return;
    const botId = activeBot.id;
    setRepairingBotIds((previous) => new Set(previous).add(botId));
    try {
      const retried = await repositories.bots.retryBot(botId);
      await refreshBots();
      if (retried) {
        handleSelectBot(retried.id);
        toast.success(t("Bot 已恢复"));
      } else {
        if (defaultBot) handleSelectBot(defaultBot.id);
        toast.success(t("异常 Bot 已清理"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Bot 修复失败，请稍后重试。"));
    } finally {
      setRepairingBotIds((previous) => {
        const next = new Set(previous);
        next.delete(botId);
        return next;
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteDialogBot || deleteInput !== deleteDialogBot.name || deletingBot) return;
    trackDatongClick("agent_delete_btn", {
      pgid: DATONG_PAGE_IDS.AGENTS_HOME,
      params: { bot_id: deleteDialogBot.id },
    });
    setDeleteError(null);
    setDeletingBot(true);
    try {
      await deleteBot(deleteDialogBot.id);
      setShowDeleteConfirm(false);
      setDeleteTargetBot(null);
      setDeleteInput("");
    } catch (err) {
      const errorCode = err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      setDeleteError(
        errorCode === "INSTANCE_BOTS_REMAIN"
          ? t("请先删除其他 Bot，再删除整个 Agent。")
          : embedded ? t("删除失败，请稍后重试。")
            : err instanceof Error ? err.message : t("删除失败，请稍后重试。"),
      );
    } finally {
      setDeletingBot(false);
    }
  };

  /* 使用平台权威 default Key 和默认模型重建当前 Hermes Profile。Key 仅在
   * 本次调用栈中进入一次性加密 envelope，不进入 React state 或 shell 文本。 */
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showAcliResetConfirm, setShowAcliResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resettingInstanceIds, setResettingInstanceIds] = useState<Set<string>>(new Set());
  const [resetConsoleByInstanceId, setResetConsoleByInstanceId] = useState<Record<string, string[]>>({});
  const resettingAcli = Boolean(activeRuntimeInstanceId && resettingInstanceIds.has(activeRuntimeInstanceId));
  useEffect(() => {
    if (!embedded || !deleteRequestId || deleteRequestId === consumedDeleteRequest.current || botsLoading) return;
    consumedDeleteRequest.current = deleteRequestId;
    onDeleteRequestHandled?.();
    const target = visibleBots.find((bot) => bot.id === deleteRequestBotId);
    if (!target) return;
    if (resettingAcli || isCreating || isModifying || resettingInstanceIds.has(target.instanceId ?? target.id)) {
      toast.error(t("删除失败，请稍后重试。"));
      return;
    }
    if (target.isDefault && bots.some((bot) => (
      bot.id !== target.id && (bot.instanceId ?? bot.id) === (target.instanceId ?? target.id)
    ))) {
      toast.error(t("请先删除其他 Bot，再删除主 Bot"));
      return;
    }
    setDeleteTargetBot(target);
    setDeleteInput("");
    setDeleteError(null);
    setShowDeleteConfirm(true);
  }, [embedded, deleteRequestId, deleteRequestBotId, onDeleteRequestHandled, botsLoading, visibleBots, bots, resettingAcli, isCreating, isModifying, resettingInstanceIds, t]);
  const acliResetConsole = activeRuntimeInstanceId ? resetConsoleByInstanceId[activeRuntimeInstanceId] ?? [] : [];
  const acliResetConsoleRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    setShowResetConfirm(false);
    setShowAcliResetConfirm(false);
    setWorkspaceConfirm(null);
  }, [activeBot?.id]);

  useEffect(() => {
    const consoleEl = acliResetConsoleRef.current;
    if (!consoleEl) return;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }, [acliResetConsole]);

  const handleResetConfig = async () => {
    if (botsLoading || maintenanceBusy || getResetBlockReason(activeBot, resetting)) return;
    const targetBotId = activeBot?.id;
    if (!targetBotId) return;

    trackDatongEvent(DATONG_EVENTS.DIAGNOSTICS_ACTION, {
      pgid: DATONG_PAGE_IDS.AGENT_DIAGNOSTICS,
      params: { bot_id: targetBotId, action: "reset_config" },
    });
    setResetting(true);
    try {
      const result = await repositories.bots.resetInstanceConfig(targetBotId);
      const modelConfigClient = createHermesModelConfigClient(
        repositories.bots.execDebugCommand,
        targetBotId,
        activeBot.profileId,
      );
      await modelConfigClient.resetToPlatformDefault({
        apiKey: result.config.apiKey,
        model: {
          id: result.config.modelId,
          providerKey: result.config.providerName,
          providerName: result.config.providerName,
          baseUrl: result.config.baseUrl,
          routeBaseUrl: result.config.baseUrl,
          apiMode: result.config.api,
          keyEnv: "",
        },
      });

      const gatewayRestartCommand = (await getHermesScriptCommands(activeBot.profileId)).getGatewayRestartCommand();
      const gatewayRestartResult = await repositories.bots.execDebugCommand(targetBotId, gatewayRestartCommand);
      if (!isExecCommandSucceeded(gatewayRestartResult)) {
        throw new Error(
          t("模型配置已恢复，但 Gateway 重启失败：{{detail}}", {
            detail: truncateExecOutput(gatewayRestartResult.output, gatewayRestartResult.status),
          }),
        );
      }

      setShowResetConfirm(false);
      toast.success(t("重置成功"));
    } catch (err) {
      const fallbackMessage = t("重置失败，请重试");
      const resetErrorCode = err && typeof err === "object" && "code" in err ? err.code : undefined;
      const message = resetErrorCode === "INSTANCE_CONFIG_RESET_MULTI_BOT"
        ? t("当前 Agent 有多个 Bot，暂不支持重置模型配置")
        : isResetConfigRouteMissingError(err)
        ? t("当前后端服务暂不支持重置配置，请稍后再试。")
        : err instanceof HermesModelConfigResponseError
          ? t("当前 Bot 的模型配置恢复失败，原配置已保留。")
          : err instanceof Error ? err.message : fallbackMessage;
      toast.error(message);
    } finally {
      setResetting(false);
    }
  };

  const handleResetAcli = async () => {
    if (!isActiveBotDefault || maintenanceBusy || getAcliResetBlockReason(activeBot, resettingAcli)) return;
    const targetBotId = activeRuntimeInstanceId;
    if (!targetBotId) return;
    const setAcliResetConsole = (update: string[] | ((prev: string[]) => string[])) => {
      setResetConsoleByInstanceId((prev) => ({
        ...prev,
        [targetBotId]: typeof update === "function" ? update(prev[targetBotId] ?? []) : update,
      }));
    };

    trackDatongEvent(DATONG_EVENTS.DIAGNOSTICS_ACTION, {
      pgid: DATONG_PAGE_IDS.AGENT_DIAGNOSTICS,
      params: { bot_id: targetBotId, action: "reset_agent" },
    });
    setResettingInstanceIds((prev) => new Set(prev).add(targetBotId));
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
      toast.success(t("Hermes 重置成功"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Hermes 重置失败，请重试");
      setAcliResetConsole((prev) => [...prev, `[error] ${message}`].slice(-80));
      toast.error(t("Hermes 重置失败，请重试"));
    } finally {
      setResettingInstanceIds((prev) => {
        const next = new Set(prev);
        next.delete(targetBotId);
        return next;
      });
    }
  };

  /* 通道弹窗 */
  const [showChannelModal, setShowChannelModal] = useState(false);

  /* ── 重启 Gateway ── */
  // restartingBotIds: 正在重启的 bot ID 集合，支持多 bot 并行重启
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [restartingBotIds, setRestartingBotIds] = useState<Set<string>>(new Set());
  const [exportingInstanceIds, setExportingInstanceIds] = useState<Set<string>>(new Set());
  const [exportStatusByInstanceId, setExportStatusByInstanceId] = useState<Record<string, WorkerActionStatusResult | null>>({});
  const [exportStatusLoadingInstanceIds, setExportStatusLoadingInstanceIds] = useState<Set<string>>(new Set());
  const [exportStatusErrors, setExportStatusErrors] = useState<Record<string, string | null>>({});
  const [importingInstanceIds, setImportingInstanceIds] = useState<Set<string>>(new Set());
  const [importStatusByInstanceId, setImportStatusByInstanceId] = useState<Record<string, WorkerActionStatusResult | null>>({});
  const [importStatusLoadingInstanceIds, setImportStatusLoadingInstanceIds] = useState<Set<string>>(new Set());
  const [importStatusErrors, setImportStatusErrors] = useState<Record<string, string | null>>({});
  const [sessionRepairPendingKeysByInstanceId, setSessionRepairPendingKeysByInstanceId] = useState<Record<string, string[]>>({});
  const [workspaceConfirm, setWorkspaceConfirm] = useState<WorkspaceConfirmState | null>(null);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const handleSessionRepairPendingChange = useCallback((change: {
    maintenanceScopeId: string;
    requestKey: string;
    pending: boolean;
  }) => {
    setSessionRepairPendingKeysByInstanceId((current) => {
      const scopeKeys = current[change.maintenanceScopeId] ?? [];
      if (change.pending) {
        if (scopeKeys.includes(change.requestKey)) return current;
        return {
          ...current,
          [change.maintenanceScopeId]: [...scopeKeys, change.requestKey],
        };
      }
      if (!scopeKeys.includes(change.requestKey)) return current;
      const nextScopeKeys = scopeKeys.filter((requestKey) => requestKey !== change.requestKey);
      const next = { ...current };
      if (nextScopeKeys.length > 0) {
        next[change.maintenanceScopeId] = nextScopeKeys;
      } else {
        delete next[change.maintenanceScopeId];
      }
      return next;
    });
  }, []);
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
      const gatewayRestartCommand = (await getHermesScriptCommands(activeBot?.profileId)).getGatewayRestartCommand();
      const result = await repositories.bots.execDebugCommand(targetBotId, gatewayRestartCommand);
      const errorMsg = buildRestartErrorMessage(result);
      if (errorMsg) {
        setRestartErrors((prev) => setErrorForBot(prev, targetBotId, errorMsg));
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
        return;
      }
      // 重新读取 Bot 列表：网关状态是重启后唯一会变的字段，不刷新的话
      // 「网关未运行」提示条会一直挂着，直到用户整页刷新。
      void refreshBots();
      // 命令已成功执行完毕，短暂保持视觉反馈后恢复
      setTimeout(() => {
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
      }, RESTART_FEEDBACK_MS);
    } catch (err) {
      setRestartErrors((prev) => setErrorForBot(prev, targetBotId, err instanceof Error ? err.message : t("重启失败")));
      setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
    }
  };

  const loadRescueExportStatus = useCallback(async (instanceId: string) => {
    setExportStatusLoadingInstanceIds((prev) => new Set(prev).add(instanceId));
    try {
      const status = await repositories.bots.getRescueExportStatus(instanceId);
      setExportStatusByInstanceId((prev) => ({ ...prev, [instanceId]: status }));
      setExportStatusErrors((prev) => ({ ...prev, [instanceId]: null }));
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : rawT("备份状态查询失败");
      setExportStatusErrors((prev) => ({ ...prev, [instanceId]: message }));
      throw err;
    } finally {
      setExportStatusLoadingInstanceIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  }, [repositories.bots]);

  const loadHermesImportStatus = useCallback(async (instanceId: string) => {
    setImportStatusLoadingInstanceIds((prev) => new Set(prev).add(instanceId));
    try {
      const status = await repositories.bots.getHermesImportStatus(instanceId);
      setImportStatusByInstanceId((prev) => ({ ...prev, [instanceId]: status }));
      setImportStatusErrors((prev) => ({ ...prev, [instanceId]: null }));
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : rawT("恢复状态查询失败");
      setImportStatusErrors((prev) => ({ ...prev, [instanceId]: message }));
      throw err;
    } finally {
      setImportStatusLoadingInstanceIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  }, [repositories.bots]);

  const handleRequestExportWorkspace = () => {
    if (!isActiveBotDefault || workspaceActionDisabledReason || maintenanceBusy) {
      toast.error(workspaceActionDisabledReason || t("Agent 维护任务执行中，请稍后再试。"));
      return;
    }
    setWorkspaceConfirm({ kind: "export" });
  };

  const handleRequestImportWorkspace = () => {
    if (!isActiveBotDefault || workspaceActionDisabledReason || maintenanceBusy) {
      toast.error(workspaceActionDisabledReason || t("Agent 维护任务执行中，请稍后再试。"));
      return;
    }
    setWorkspaceConfirm({ kind: "import", file: null });
  };

  const handleExportWorkspace = async () => {
    if (!activeRuntimeInstanceId || !isActiveBotDefault || workspaceActionDisabledReason || maintenanceBusy) return;
    const targetInstanceId = activeRuntimeInstanceId;
    setWorkspaceConfirm(null);
    setExportingInstanceIds((prev) => new Set(prev).add(targetInstanceId));
    setExportStatusByInstanceId((prev) => ({
      ...prev,
      [targetInstanceId]: {
        phase: "starting",
        logs: [{ time: new Date().toISOString(), phase: "starting", message: t("正在发起 Agent 备份任务。"), level: "info" }],
      },
    }));
    try {
      await repositories.bots.startRescueExport(targetInstanceId);
      toast.success(t("备份任务已发起，完成后会发送到绑定邮箱。"));
      await loadRescueExportStatus(targetInstanceId).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("action_already_running")) {
        toast.success(t("已有备份任务正在执行，已为你加载当前进度。"));
        await loadRescueExportStatus(targetInstanceId).catch(() => undefined);
        return;
      }
      const friendlyMessage = message.includes("cos_upload_bucket_not_configured")
        ? t("备份存储桶未配置，请稍后再试。")
        : describeWorkspaceActionError("export", message || t("备份任务发起失败")).message;
      setExportStatusByInstanceId((prev) => ({
        ...prev,
        [targetInstanceId]: {
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
      setExportingInstanceIds((prev) => {
        const next = new Set(prev);
        next.delete(targetInstanceId);
        return next;
      });
    }
  };

  const handleSelectHermesImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!isActiveBotDefault || workspaceActionDisabledReason || maintenanceBusy) {
      toast.error(workspaceActionDisabledReason || t("Agent 维护任务执行中，请稍后再试。"));
      return;
    }
    setWorkspaceConfirm({ kind: "import", file });
  };

  const handleImportWorkspace = async (file: File) => {
    if (!activeRuntimeInstanceId || !isActiveBotDefault || workspaceActionDisabledReason || maintenanceBusy) return;
    const targetInstanceId = activeRuntimeInstanceId;
    setWorkspaceConfirm(null);
    setImportingInstanceIds((prev) => new Set(prev).add(targetInstanceId));
    setImportStatusByInstanceId((prev) => ({
      ...prev,
      [targetInstanceId]: {
        phase: "starting",
        logs: [{ time: new Date().toISOString(), phase: "starting", message: t("正在上传 Agent 恢复包。"), level: "info" }],
      },
    }));
    try {
      await repositories.bots.importHermesWorkspace(targetInstanceId, file);
      toast.success(t("恢复任务已发起，完成后会发送到绑定邮箱。"));
      await loadHermesImportStatus(targetInstanceId).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("action_already_running")) {
        toast.success(t("已有恢复任务正在执行，已为你加载当前进度。"));
        await loadHermesImportStatus(targetInstanceId).catch(() => undefined);
        return;
      }
      const friendlyMessage = describeWorkspaceActionError("import", message || t("恢复任务发起失败")).message;
      setImportStatusByInstanceId((prev) => ({
        ...prev,
        [targetInstanceId]: {
          phase: "failed",
          error: friendlyMessage,
          logs: [{ time: new Date().toISOString(), phase: "failed", message: friendlyMessage, level: "error" }],
        },
      }));
      toast.error(friendlyMessage);
    } finally {
      setImportingInstanceIds((prev) => {
        const next = new Set(prev);
        next.delete(targetInstanceId);
        return next;
      });
    }
  };

  // 当前 tab 的 bot 是否正在重启
  const isActiveBotRestarting = computeIsActiveBotRestarting(activeBot, restartingBotIds);
  const isActiveBotExporting = activeRuntimeInstanceId ? exportingInstanceIds.has(activeRuntimeInstanceId) : false;
  const isActiveBotImporting = activeRuntimeInstanceId ? importingInstanceIds.has(activeRuntimeInstanceId) : false;
  const isActiveSessionRepairing = activeRuntimeInstanceId
    ? (sessionRepairPendingKeysByInstanceId[activeRuntimeInstanceId]?.length ?? 0) > 0
    : false;
  const activeExportStatus = activeRuntimeInstanceId ? exportStatusByInstanceId[activeRuntimeInstanceId] ?? null : null;
  const activeImportStatus = activeRuntimeInstanceId ? importStatusByInstanceId[activeRuntimeInstanceId] ?? null : null;
  const isActiveExportStatusLoading = activeRuntimeInstanceId ? exportStatusLoadingInstanceIds.has(activeRuntimeInstanceId) : false;
  const isActiveImportStatusLoading = activeRuntimeInstanceId ? importStatusLoadingInstanceIds.has(activeRuntimeInstanceId) : false;
  const activeExportStatusError = activeRuntimeInstanceId ? exportStatusErrors[activeRuntimeInstanceId] ?? null : null;
  const activeImportStatusError = activeRuntimeInstanceId ? importStatusErrors[activeRuntimeInstanceId] ?? null : null;
  const activeWorkspaceTask = selectCurrentWorkspaceTask(activeExportStatus, activeImportStatus);
  const workspaceActionDisabledReason = buildWorkspaceActionDisabledReason({
    hasActiveBot: Boolean(activeBot),
    botRunning: activeBot?.status === "running",
    hasEmail: Boolean(user?.email),
    resetting: resettingAcli || resetting,
    currentTask: activeWorkspaceTask,
  });
  const maintenanceBusy = resetting || resettingAcli || isActiveBotExporting || isActiveBotImporting
    || isActiveSessionRepairing
    || isActiveExportStatusLoading || isActiveImportStatusLoading
    || isWorkspaceActionRunning(activeWorkspaceTask?.status);
  // 当前 tab 是否展示错误
  const activeBotRestartError = getActiveBotRestartError(activeBot, restartErrors);
  const sdkInstance = useMemo<TeaSdkInstanceInfo | null>(() => {
    if (!activeBot) return null;
    return {
      InstanceId: activeBot.instanceId ?? activeBot.id,
      ProfileId: activeBot.profileId ?? "main",
      RegionId: 1,
    };
  }, [activeBot?.id, activeBot?.instanceId, activeBot?.profileId]);

  /**
   * 实例切换时重置会话操作状态（SDK 对接注意事项 3）。
   * 列表由账号与 Bot 键隔离；选中值和 actions 仍须清理，避免旧实例的
   * rename 句柄指向新实例。selectedChatId 回到 undefined 后由 SDK 下发默认会话。
   */
  useEffect(() => {
    chatSessionPagination.reset();
    setChatSessionsHasMore(false);
    setChatPinSupported(false);
    setPinningChatIds(new Set());
    setChatPinError(null);
    setChatSessionMutationState(null);
    setSelectedChatId(undefined);
    setChatSessionActions(null);
    setChatSessionCommands(null);
    setRenamingChatId(null);
    setRenamingDraft("");
    setOpenSessionMenuChatId(null);
    setSessionToDelete(null);
  }, [sdkInstance?.InstanceId, sdkInstance?.ProfileId, chatSessionPagination.reset]);

  const sdkFeatureFlags = useMemo<TeaSdkFeatureFlags>(() => ({
    gateway: true,
    channel: true,
    wecomChannel: true,
    adpChannel: false,
    wecomLongConn: true,
    yuanbaoChannel: false,
    weixinChannel: !weixinOccupiedByOther,
    qrConfig: true,
    skills: true,
    webUI: false,
    memoryManagement: false,
    memoryV2: false,
    qqbotplugin: false,
  }), [weixinOccupiedByOther]);
  // 从七彩石拉取模型列表移到 TeaSdkSettingsPanel（需 runtime.useModelProviders）
  const { i18n } = useTranslation();
  const useEnglish = shouldUseEnglishProviderData(i18n.language);
  const shouldExposeWorkspaceRecoveryPanel = shouldShowWorkspaceRecoveryPanel({
    isGlobalRegion: isGlobal,
    hiddenToolsRevealed: showHiddenAgentTools,
  });

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeRuntimeInstanceId) return;
    void loadRescueExportStatus(activeRuntimeInstanceId).catch(() => undefined);
    void loadHermesImportStatus(activeRuntimeInstanceId).catch(() => undefined);
  }, [activeSection, activeRuntimeInstanceId, loadRescueExportStatus, loadHermesImportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeRuntimeInstanceId || !isRescueExportRunning(activeExportStatus)) return;
    const timer = window.setInterval(() => {
      void loadRescueExportStatus(activeRuntimeInstanceId).catch(() => undefined);
    }, RESCUE_EXPORT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSection, activeRuntimeInstanceId, activeExportStatus?.phase, loadRescueExportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    if (!shouldExposeWorkspaceRecoveryPanel || activeSection !== "diagnostics" || !activeRuntimeInstanceId || !isRescueExportRunning(activeImportStatus)) return;
    const timer = window.setInterval(() => {
      void loadHermesImportStatus(activeRuntimeInstanceId).catch(() => undefined);
    }, RESCUE_EXPORT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSection, activeRuntimeInstanceId, activeImportStatus?.phase, loadHermesImportStatus, shouldExposeWorkspaceRecoveryPanel]);

  useEffect(() => {
    return subscribeConsoleShow((enabled) => {
      setShowHiddenAgentTools(enabled);
      setConsoleShowStateReady(true);
    });
  }, []);

  useEffect(() => {
    return installOpenClawConsoleHelpers({
      host: window as Window & { help?: unknown; terminal?: unknown; show?: unknown; console: Console },
      getTerminalPath: () => (activeBot ? AGENT_SECTION_PATH_BY_ID.terminal : null),
      enableShowCommand: true,
    });
  }, [activeBot]);

  /*
   * 订阅成功后的命名向导：subscribe-page 支付成功后不再写死默认名自动建 Bot，而是跳到
   * /agents?create=1。这里在订阅态与列表就绪后，自动打开与「新建 Bot」一致的命名弹窗
   * （首个创建 → 空白模式、只需输入名字），让首次订阅与删除后重建走同一条命名流程。
   *
   * 消费一次即清掉 create 参数（replace）。本次挂载只打开一次；如果用户中途离开，
   * 下次进 /agents 时，只要仍没有成功创建 Bot，就重新打开引导。
   * 边界：当前已有 Bot 时直接落到正常控制台；Bot 已删光时重新打开创建界面；
   *       未订阅（理论上不会跳来，或 pass 尚未同步）先等待，不误弹。
   */
  useEffect(() => {
    if (firstCreateEntryHandled.current) return;
    if (!createBotIntentParam && pathname !== AGENTS_HOME_PATH) return;
    if (!hasResolvedBots || botsLoading || passesLoading) return;
    if (!isSubscribed) return;
    firstCreateEntryHandled.current = true;
    if (createBotIntentParam) navigate(AGENTS_HOME_PATH, { replace: true });
    if (bots.length > 0) return;
    setDirectCreateError(null);
    setCreateBotName("");
    /*
     * 订阅成功回跳同样进创建引导，不弹旧的「创建 Bot」弹窗 ——
     * 这是新用户订阅后的第一屏，看到的必须是新流程。
     *
     * 国际站引导未上线，回落到旧的「创建 Bot」弹窗（master 原行为）。
     */
    setCloneSourceBotId("");
    if (IS_BUDDY_ONBOARDING_ENABLED) {
      setShowMultiBotOnboarding(true);
    } else {
      setCreateBotMode("blank");
      setShowCreateConfirm(true);
    }
  }, [createBotIntentParam, pathname, hasResolvedBots, botsLoading, passesLoading, isSubscribed, bots.length, navigate]);

  /*
   * 新订阅用户打标。
   *
   * 创建流程有多条退出路径（completedCreatingBot / 兜底退出 / polling 的
   * active|failed|deleting 分支），逐条打标必然漏。所以只要 URL 出现过
   * `?creating=`，就在这里统一打标 —— 时机早于任何退出分支，不会错过。
   */
  useEffect(() => {
    if (!creatingParam) return;
    const targetBotId = requestedCreatingBotId || provisioningBot?.id || completedCreatingBot?.id;
    if (targetBotId) markPendingOnboarding(targetBotId);
  }, [creatingParam, requestedCreatingBotId, provisioningBot?.id, completedCreatingBot?.id]);

  useEffect(() => {
    if (!creatingParam) return;
    /*
     * 引导正在写配置时不要动 URL。
     *
     * 订阅路径的实例进页面就已是 running，completedCreatingBot 立刻匹配，
     * 这里会把 ?creating=<id> 改写成 ?bot=<id> —— creatingParam 一消失，
     * isCreating 变 false、showEarlyOnboarding 变 false，引导面板连同
     * activeTemplate / phase 一起被卸载。用户点模板后瞬间回到表单、
     * 配置一步都没跑，就是这条路径造成的。
     *
     * 前面两个兜底 effect 已各自让位，这条是第三处（也是真正改 URL 的那处）。
     */
    if (onboardingLockRef.current) return;
    if (completedCreatingBot) {
      setIsCreating(false);
      setCreationError(null);
      setActiveTabId(completedCreatingBot.id);
      navigate(getAgentBotSectionHref(AGENTS_HOME_PATH, completedCreatingBot.id), { replace: true });
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
    /*
     * 引导进行中不要抢方向盘。
     *
     * 多 bot 引导在本页点「创建」后会立刻产出一个 provisioning 实例，而此时
     * URL 上没有 ?creating=。本 effect 于是判定「刷新恢复」，把 isCreating
     * 翻成 true 并跳 ?creating=<id> —— showEarlyOnboarding 随之变 true，渲染
     * 从多 bot 分支切到订阅分支。两个分支在 DOM 里位置不同，面板被真重挂载
     * （日志里 id 由 vxztw 变成 lpjon），phase 归零回 form，正在跑的配置流程
     * 被 cleanup 取消 —— 表现为 sandbox ready=false、点完「创建」回到表单。
     *
     * 引导自己会在 onCreated 里跳转收尾，不需要这里代劳。
     */
    if (onboardingLockRef.current) return;
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
    // 等路由先确认创建流程，避免确认按钮的 state 更新早于 ?creating= 导航时误退出。
    if (!isCreating || creationError || !creatingParam) return;
    /*
     * 引导正在写配置时绝不退出 loading。
     *
     * 订阅路径的实例进页面就已是 running，这个 effect 会立刻判定「就绪」并
     * setIsCreating(false) → showEarlyOnboarding 变 false → 引导面板卸载。
     * 用户点完模板瞬间被弹回表单，配置一步都没跑（真实故障）。
     * 收尾交给 onCreated（handleBuddyCreated），它带着新 bot id 正常跳转。
     */
    if (onboardingLockRef.current) return;
    if (requestedCreatingBotId) {
      const targetBot = bots.find((b) => b.id === requestedCreatingBotId);
      if (targetBot && targetBot.status !== "provisioning" && targetBot.status !== "deleting") {
        setIsCreating(false);
        setCreationError(null);
        setActiveTabId(targetBot.id);
        navigate(getAgentBotSectionHref(AGENTS_HOME_PATH, targetBot.id), { replace: true });
      }
      return;
    }
    if (!provisioningBot && bots.some((b) => b.status !== "provisioning" && b.status !== "deleting")) {
      setIsCreating(false);
      setCreationError(null);
      navigate(AGENTS_HOME_PATH, { replace: true });
    }
  }, [isCreating, creationError, creatingParam, requestedCreatingBotId, bots, provisioningBot, navigate]);

  /* 创建态只以后端真实状态为准：Running 才进入设置页，Failed/Deleting 停在错误态。 */
  useEffect(() => {
    if (!isCreating || creationError) return;
    /*
     * 同上：引导进入配置阶段后不再由轮询决定去留。
     *
     * 订阅路径的实例本来就是 active，这里的 active 分支会立刻
     * setIsCreating(false) + navigate，把正在写配置的引导面板卸载掉。
     */
    if (onboardingLockRef.current) return;

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
          await refreshBots();
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(getAgentBotSectionHref(AGENTS_HOME_PATH, targetBotId), { replace: true });
          return;
        }

        if (targetBot.status === "failed") {
          await refreshBots();
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(getAgentBotSectionHref(AGENTS_HOME_PATH, targetBotId), { replace: true });
          return;
        }

        if (targetBot.status === "deleting") {
          await refreshBots();
          setIsCreating(false);
          setCreationError(null);
          navigate(AGENTS_HOME_PATH, { replace: true });
          return;
        }

        if (targetBot.status !== "provisioning") {
          await refreshBots();
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate(getAgentBotSectionHref(AGENTS_HOME_PATH, targetBotId), { replace: true });
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

  const createBotAndNavigate = async ({
    name,
    createMode,
    sourceBotId,
  }: {
    name: string;
    createMode: "blank" | "clone";
    sourceBotId?: string;
  }) => {
    setDirectCreating(true);
    setDirectCreateError(null);
    const createStart = Date.now();
    try {
      const newBot = await addBot({
        name,
        description: undefined,
        personality: t("默认设定"),
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
        createMode,
        sourceBotId,
      });
      trackDatongEvent(DATONG_EVENTS.AGENT_CREATE_SUCCESS, {
        pgid: DATONG_PAGE_IDS.AGENT_CREATING,
        params: {
          bot_id: newBot.id,
          create_duration_ms: Date.now() - createStart,
        },
      });
      setShowCreateConfirm(false);
      setIsCreating(true);
      navigate(`${AGENTS_HOME_PATH}?creating=${encodeURIComponent(newBot.id)}`, { replace: true });
    } catch (err) {
      setDirectCreateError(getAgentCreateErrorMessage(err, (message) => t(message)));
    } finally {
      setDirectCreating(false);
    }
  };

  const handleCreateNew = useCallback(() => {
    trackDatongClick("agent_create_start_btn", {
      pgid: DATONG_PAGE_IDS.AGENTS_HOME,
      params: { bots_count: bots.length },
    });
    if (createLimitMessage) {
      setDirectCreateError(createLimitMessage);
      return;
    }
    if (activeBot && !canCreateAdditionalBot) return;
    if (!activeBot) {
      if (!isSubscribed) {
        navigate("/subscribe");
        return;
      }
      /*
       * 首个 bot 也走创建引导，不再弹旧的「创建 Bot」弹窗。
       *
       * 之前这条分支还留着弹窗 —— 那是只问名字的老交互，新用户第一次
       * 建 bot 恰好走这里，于是看到的还是旧界面。引导页能选头像、填描述、
       * 挑模板，弹窗一个都没有，两者并存还会让用户填两次名字。
       *
       * 首个 bot 不传 cloneOptions（没有可复制的来源），引导页会隐藏
       * 「创建方式」那一档，addBot 收到空 sourceBotId 走 blank。
       *
       * 国际站引导未上线，回落到旧的「创建 Bot」弹窗（master 原行为）。
       */
      setDirectCreateError(null);
      setCreateBotName("");
      setCloneSourceBotId("");
      if (IS_BUDDY_ONBOARDING_ENABLED) {
        setShowMultiBotOnboarding(true);
      } else {
        setCreateBotMode("blank");
        setShowCreateConfirm(true);
      }
      return;
    }

    /*
     * 多 bot：直接进配置引导，不再先弹一次「创建 Bot」弹窗。
     *
     * 弹窗问的名字 + 创建方式，引导页里都有；两者并存会让用户填两次名字。
     * 实例在引导页点「创建」时才建（见 handleOnboardingCreateBot）——
     * 必须这样，因为「复制哪个 bot」是用户在引导页里选的。
     */
    setDirectCreateError(null);
    setCreateBotName("");
    /*
     * 默认空白创建（空串）。
     *
     * 复制会把来源 bot 的人设、技能、记忆一起带过来，属于「我知道自己
     * 要什么」的进阶用法；新建的默认预期是拿到一个干净的 bot，所以默认
     * 不复制，想复制的人自己去高级里选。
     */
    setCloneSourceBotId("");
    /* 国际站引导未上线，回落到旧的「创建 Bot」弹窗（master 原行为：clone-current） */
    if (IS_BUDDY_ONBOARDING_ENABLED) {
      setShowMultiBotOnboarding(true);
      const createPageParams = new URLSearchParams(searchParams);
      createPageParams.set(AGENT_CREATE_PAGE_QUERY_KEY, "1");
      navigate(`${pathname}?${createPageParams.toString()}`);
    } else {
      setCreateBotMode("clone-current");
      setShowCreateConfirm(true);
    }
  }, [activeBot, bots.length, canCreateAdditionalBot, createLimitMessage, isSubscribed, navigate, pathname, searchParams]);

  const nativeCreateVisible = !activeBot || multiBotEnabled;
  const nativeCreateEnabled = nativeCreateVisible
    && !botsLoading && !passesLoading && !isCreating && !isModifying && !directCreating
    && (activeBot ? canCreateAdditionalBot : canCreateInitialAgent);
  useEffect(() => {
    if (!embedded) return;
    window.dispatchEvent(new CustomEvent("opencraft-mobile-bot-create-state", {
      detail: { visible: nativeCreateVisible, enabled: nativeCreateEnabled },
    }));
  }, [embedded, nativeCreateVisible, nativeCreateEnabled]);
  const consumedCreateRequest = useRef(0);
  useEffect(() => {
    if (!embedded || !createRequestId || createRequestId === consumedCreateRequest.current) return;
    if (botsLoading || passesLoading || isCreating || isModifying || directCreating) return;
    consumedCreateRequest.current = createRequestId;
    onCreateRequestHandled?.();
    if (nativeCreateEnabled) handleCreateNew();
  }, [embedded, createRequestId, botsLoading, passesLoading, isCreating, isModifying, directCreating, nativeCreateEnabled, onCreateRequestHandled, handleCreateNew]);

  const handleCloneBot = () => {
    const sourceBotId = activeBot?.id;
    if (createLimitMessage || (activeBot ? !canCreateAdditionalBot : !canCreateInitialAgent)) return;
    if (sourceBotId && !visibleBots.some((bot) => bot.id === sourceBotId && bot.status === "running" && bot.profileId)) return;
    handleCreateNew();
    if (sourceBotId) setCloneSourceBotId(sourceBotId);
  };

  /**
   * 引导页里的「创建」：真正建实例。
   *
   * 与 handleConfirmCreate 的区别是不跳 `?creating=` —— 引导面板自己会接着
   * 显示写配置进度，跳转会让它卸载、配置写到一半断掉。
   * 返回 profileId 供面板定位写入目标，避免它再去猜。
   */
  const handleOnboardingCreateBot = useCallback(async (params: {
    name: string;
    sourceBotId: string;
  }): Promise<{ botId: string; profileId: string } | null> => {
    if (createLimitMessage) {
      setDirectCreateError(createLimitMessage);
      return null;
    }
    /*
     * sourceBotId 为空 = 空白创建（默认），走 createMode: "blank"；
     * 有值则克隆那个 bot。不再因为「没选来源」而报错 —— 空白创建本身
     * 就是一个合法且默认的选项。
     */
    const isBlank = !params.sourceBotId;
    try {
      const newBot = await addBot({
        name: params.name,
        description: undefined,
        personality: t("默认设定"),
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
        createMode: isBlank ? "blank" : "clone",
        sourceBotId: isBlank ? undefined : params.sourceBotId,
      });
      // 新 bot 还没进 visibleBots（provisioning 会被过滤），所以直接用返回值
      const createdProfileId = newBot.profileId || "";
      /*
       * 守卫：多 bot 场景下拿到 "main" 视为「没拿到」。
       *
       * addBot 在后端没返回 profile_id 时会兜底成 "main"（见 agent-context
       * 的 `created.profileId ?? "main"`）。而 "main" 是主 bot 的 profile ——
       * 如果就这么往下走，模板的技能和定时任务会全部写进主 bot：新 bot 里
       * 空空如也，主 bot 那边莫名多出几条，且没有任何报错。
       *
       * activeBot 存在说明这是「在已有 bot 之上再建一个」，它的 profile 不
       * 可能是 main。这种情况下返回 null，让引导退回表单并提示重试，
       * 比静默写脏主 bot 好得多。
       */
      if (activeBot && (!createdProfileId || createdProfileId === "main")) {
        setDirectCreateError(t("Bot 已创建，但配置写入所需的档案标识未就绪，请稍后在设置页重试配置。"));
        return null;
      }

      // Preserve this route and mounted panel, but reload into the new Bot.
      const recoveryUrl = new URL(window.location.href);
      recoveryUrl.searchParams.set("bot", newBot.id);
      window.history.replaceState(window.history.state, "", recoveryUrl);
      return { botId: newBot.id, profileId: createdProfileId };
    } catch (err) {
      setDirectCreateError(getAgentCreateErrorMessage(err, (message) => t(message)));
      return null;
    }
  }, [createLimitMessage, addBot, activeBot, t, session?.user?.id]);

  const handleConfirmCreate = async () => {
    if (createLimitMessage) {
      setDirectCreateError(createLimitMessage);
      return;
    }
    trackDatongClick("agent_create_confirm_btn", {
      pgid: DATONG_PAGE_IDS.AGENT_CREATING,
      params: {},
    });
    const normalizedName = createBotName.trim();
    if (!normalizedName) {
      setDirectCreateError(t("请输入 Bot 名称"));
      return;
    }
    if (Array.from(normalizedName).length > MAX_BOT_NAME_LENGTH) {
      setDirectCreateError(t("最大不能超过 {{max}} 字符。", { max: MAX_BOT_NAME_LENGTH }));
      return;
    }
    const cloneIntent = resolveBotCloneIntent({
      isInitialCreation: isFirstBotCreation,
      selection: createBotMode,
      currentBotId: activeBot?.id,
      mainBotId: defaultBot?.id,
    });
    if (!cloneIntent.ok) {
      setDirectCreateError(t("找不到可克隆的 Bot，请选择空白创建。"));
      return;
    }
    await createBotAndNavigate({
      name: normalizedName,
      createMode: cloneIntent.intent.mode,
      sourceBotId: cloneIntent.intent.mode === "clone" ? cloneIntent.intent.sourceBotId : undefined,
    });
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
  const canStartWorkspaceAction = isActiveBotDefault && !workspaceActionDisabledReason && !maintenanceBusy;
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
  const workspaceRecoveryPanel = shouldExposeWorkspaceRecoveryPanel && isActiveBotDefault && activeBot ? (
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
          <li>{t("备份包含整个 Agent 中所有 Bot 的配置、工作空间、记忆和已安装技能等数据。")}</li>
          <li>{t("恢复会覆盖目标 Agent 中的对应数据，影响所有 Bot。任务结果将通过绑定邮箱通知。")}</li>
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
                if (!activeRuntimeInstanceId) return;
                void Promise.all([
                  loadRescueExportStatus(activeRuntimeInstanceId).catch(() => undefined),
                  loadHermesImportStatus(activeRuntimeInstanceId).catch(() => undefined),
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
    <div
      ref={chatPageRef}
      className={cn(
        "flex flex-col bg-white",
        agentChatPageMinHeightClass(useMobileChatLayout),
        activeSection === "chat" && "lv-agent-chat-page",
        activeSection === "chat" && openCraftChatEnabled && hasSidebarLayout && "lv-agent-embedded-chat-page",
        mobileChatNavOpen && "lv-agent-mobile-nav-open",
        (hasSidebarLayout || shouldShowDataLoading) && !embedded && multiBotEnabled && "lv-agent-bot-rail-enabled",
        isEmptyAgentPage && "lv-agent-empty-page",
        isModifying && "lv-agent-upgrading-page",
        isSidebarCollapsed && "lv-agent-sidebar-collapsed",
        !localSidebar.transitionReady && "lv-agent-sidebar-motion-pending",
      )}
      style={{ color: "rgba(0,0,0,0.90)" }}
    >
      {showHeader && (
        <ProductReturnHomeHeader
          beforeUserMenu={(hasSidebarLayout || shouldShowDataLoading) ? (
            <AgentSidebarToggle collapsed={isSidebarCollapsed} onToggle={localSidebar.toggle} />
          ) : undefined}
          /*
           * lv-agent-sidebar-header 会把 header 固定成 264px 宽的侧边栏表头
           * （见 styles.css 的 @media min-width:1024px）。没有侧边栏时它会留下
           * 一块孤立的空白竖条，所以按 hasSidebarLayout 决定是否套用。
           *
           * 骨架屏期间一并套上 —— 内容区此时已按侧边栏布局排版，header 若还是
           * 全宽会跟下方的两列对不齐。
           *
           * --borderless 只给创建 / 引导态：那时右侧没有侧边栏，header 的
           * 右边框和下边框会把 logo 框成一个孤立小方块。常规页面要保留边框，
           * 它和侧边栏的分隔线是连着的。
           */
          className={cn(
            (hasSidebarLayout || shouldShowDataLoading) && "lv-agent-sidebar-header",
            isSidebarCollapsed && "lv-agent-sidebar-header--collapsed",
            !localSidebar.transitionReady && "lv-agent-sidebar-header--motion-pending",
            (showBuddyOnboarding || showMultiBotOnboarding) && "lv-agent-sidebar-header--borderless",
          ) || undefined}
          reloadLanguageAfterSwitch
          showDesktopUserMenu={false}
        />
      )}
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
      {showDeleteConfirm && deleteDialogBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!deletingBot) setShowDeleteConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-[28rem] rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>
                {deleteDialogBot.isDefault ? t("删除整个 Agent") : t("删除 Bot")}
              </h3>
            </div>
            <p className="rounded-xl border border-red-100 bg-red-50/70 px-3.5 py-3 text-sm leading-relaxed text-red-700" style={{ marginBottom: "6px" }}>
              <span className="block font-semibold">{t("风险提示：")}</span>
              <span className="mt-1 block">
                {deleteDialogBot.isDefault
                  ? t("删除后，整个 Agent 的会话、配置、已安装技能和记忆等数据将无法恢复。请谨慎操作！")
                  : t("删除后，当前 Bot 的会话、配置、已安装技能和记忆等数据将无法恢复。请谨慎操作！")}
              </span>
            </p>
            {deleteDialogBot.isDefault && deleteDialogBot.siblingsUnknown && (
              <p
                data-testid="delete-siblings-unknown-warning"
                className="rounded-xl border border-amber-200 bg-amber-50/80 px-3.5 py-3 text-sm leading-relaxed text-amber-800"
                style={{ marginBottom: "6px" }}
              >
                {deleteDialogBot.siblingsUnknown === "instance_stopped"
                  ? t("实例未运行，当前无法列出这个 Agent 下的其他 Bot。继续删除会一并销毁实例上的全部 Bot 及其数据。")
                  : t("暂时无法获取这个 Agent 的 Bot 列表。继续删除会一并销毁实例上的全部 Bot 及其数据。")}
              </p>
            )}
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              <span className="block">
                {deleteDialogBot.isDefault ? t("如确认删除整个 Agent，请输入主 Bot 名称") : t("如确认删除 Bot，请输入 Bot 名称")}{" "}
                <span className="select-all rounded-md bg-red-50 px-1.5 py-0.5 font-semibold text-red-600">
                  {deleteDialogBot.name}
                </span>
                。
              </span>
            </p>
            <input
              type="text"
              placeholder={t("请输入 {{name}}", { name: deleteDialogBot.name })}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              disabled={deletingBot}
              className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]"
              style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }}
            />
            {deleteError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteError}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleDelete()}
                disabled={deleteInput !== deleteDialogBot.name || deletingBot}
                aria-busy={deletingBot}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all"
                style={{
                  backgroundColor: deleteInput === deleteDialogBot.name ? "#DC2626" : "#E5E7EB",
                  cursor: deleteInput === deleteDialogBot.name && !deletingBot ? "pointer" : "not-allowed",
                  fontSize: "16px",
                }}
              >
                {deletingBot && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />}
                {deletingBot ? t("删除中...") : deleteDialogBot.isDefault ? t("确认删除 Agent") : t("确认删除 Bot")}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} disabled={deletingBot} className="py-2 text-[16px] transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: deletingBot ? "not-allowed" : "pointer", fontSize: "16px" }}>
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Session Delete Confirm Dialog */}
      {sessionToDelete && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={cancelSessionDelete}
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
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("删除会话")}</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {openCraftChatEnabled && "running" in sessionToDelete && sessionToDelete.running === true
                ? t("会话「{{name}}」正在执行。确认后将先停止任务，待停止成功再删除会话。此操作不可撤销。", { name: sessionToDelete.title || t("默认会话") })
                : t("确定要删除会话「{{name}}」吗？此操作不可撤销。", { name: sessionToDelete.title || t("默认会话") })}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={confirmSessionDelete}
                className="w-full rounded-xl px-4 py-2.5 text-[16px] font-semibold text-white transition-all"
                style={{ backgroundColor: "#DC2626", cursor: "pointer", fontSize: "16px" }}
              >
                {openCraftChatEnabled && "running" in sessionToDelete && sessionToDelete.running === true ? t("停止并删除") : t("确认删除")}
              </button>
              <button onClick={cancelSessionDelete} className="py-2 text-[16px] transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer", fontSize: "16px" }}>
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
            className="mx-4 w-full max-w-md rounded-lg border bg-white p-6 shadow-2xl"
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

      {/* Reset Hermes Confirm Dialog */}
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
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("重置 Hermes（保留数据）")}</h3>
            </div>
            <p style={{ color: "var(--tea-color-text-secondary, #666)", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("将重置 Hermes 运行环境，影响其中的所有 Bot。")}
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
                {resettingAcli ? t("重置中...") : t("确认重置")}
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
            className="mx-4 max-h-[calc(100dvh-2rem)] w-full max-w-[42rem] overflow-y-auto rounded-lg border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(7,193,96,0.08)" }}>
                <Plus className="h-5 w-5" style={{ color: "#07C160" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("创建 Bot")}</h3>
            </div>
            <div className="space-y-4">
              <label className="block space-y-2 text-sm font-medium text-black/70">
                <span className="flex items-center justify-between gap-3">
                  <span>{t("Bot 名称")}</span>
                  <span className="text-xs font-normal tabular-nums text-black/40">
                    {Array.from(createBotName).length}/{MAX_BOT_NAME_LENGTH}
                  </span>
                </span>
                <input
                  value={createBotName}
                  onChange={(event) => setCreateBotName(event.target.value)}
                  placeholder={t("请输入 Bot 名称")}
                  maxLength={MAX_BOT_NAME_LENGTH}
                  disabled={directCreating}
                  className="h-10 w-full rounded-md border border-black/10 px-3 text-sm text-black/85 outline-none focus:border-[#2F6BFF] focus:ring-2 focus:ring-[#2F6BFF]/15"
                />
              </label>
              {!isFirstBotCreation && (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-black/70">{t("创建方式")}</legend>
                    <div
                      className={cn(
                        "grid overflow-hidden rounded-md border border-black/10",
                        isActiveBotDefault ? "grid-cols-2" : "grid-cols-3",
                      )}
                      role="radiogroup"
                    >
                      {([
                        ["clone-current", isActiveBotDefault ? t("复制当前（主 Bot）") : t("复制当前")],
                        ...(!isActiveBotDefault ? [["clone-main", t("复制主 Bot")] as const] : []),
                        ["blank", t("空白创建")],
                      ] as const).map(([mode, label]) => {
                        const selected = createBotMode === mode;
                        const unavailable = mode !== "blank" && (mode === "clone-current" ? !activeBot : !defaultBot);
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={directCreating || unavailable}
                            onClick={() => setCreateBotMode(mode)}
                            className={cn(
                              "min-h-10 border-r border-black/10 px-2 text-xs font-medium last:border-r-0",
                              selected ? "bg-black text-white" : "bg-white text-black/55 hover:bg-black/[0.03]",
                              unavailable && "cursor-not-allowed opacity-40",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  {createBotMode === "blank" ? (
                    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md bg-black/[0.035] px-3 py-2 text-xs leading-5 text-black/55">
                      <dt className="whitespace-nowrap font-medium text-black/70">{t("继承")}</dt>
                      <dd className="min-w-0 text-pretty">{t("主 Bot 当前主模型及其 Provider 凭据")}</dd>
                      <dt className="whitespace-nowrap font-medium text-black/70">Skills</dt>
                      <dd className="min-w-0 text-pretty">{t("系统预置")}</dd>
                      <dt className="whitespace-nowrap font-medium text-black/70">{t("不继承")}</dt>
                      <dd className="min-w-0 text-pretty">{t("备用模型、其他已配置模型、人设、记忆、主 Bot 后续安装的 Skills、通道和定时任务")}</dd>
                    </dl>
                  ) : (
                    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md bg-black/[0.035] px-3 py-2 text-xs leading-5 text-black/55">
                      <dt className="whitespace-nowrap font-medium text-black/70">{t("继承")}</dt>
                      <dd className="min-w-0 text-pretty">{t("模型、人设、技能、用户偏好和长期记忆")}</dd>
                      <dt className="whitespace-nowrap font-medium text-black/70">{t("不继承")}</dt>
                      <dd className="min-w-0 text-pretty">{t("当前对话、历史会话、定时任务、运行状态或通道连接")}</dd>
                    </dl>
                  )}
                </>
              )}
            </div>
            {directCreateError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{directCreateError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateConfirm(false)}
                disabled={directCreating}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-medium text-black/60 transition-colors hover:bg-black/[0.035] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmCreate()}
                disabled={directCreating}
                className="inline-flex h-9 min-w-24 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed"
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
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      <AnimatePresence>
        {renewPassModalOpen && renewalAvailable && activePass && (
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

      <main
        className={cn(
          "lw-app-top-pad flex-grow bg-white",
          useMobileChatLayout ? "pb-0" : "pb-6",
          /*
           * lv-agent-settings-main 把顶部内边距压到 68px，配套的是
           * lv-agent-sidebar-header 那个 264px 宽的侧边栏表头。没有侧边栏时
           * 用的是普通全宽 header（高度按 lw-app-top-pad 的 96px 算）。
           * header 是 position:fixed，所以内边距本身必须保留。
           *
           * 骨架屏期间也套这套：骨架画的就是「侧边栏 + 内容」两列，而它渲染时
           * bot 还没加载完（hasSidebarLayout 仍是 false）。若不一起套，骨架会
           * 按 96px 顶距 + 居中窄容器排版，数据到位后再跳成 68px + 左对齐宽
           * 容器 —— 那一下横竖双向的位移就是加载图跟成品对不齐的原因。
           */
          !embedded && (hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-main",
          /* 聊天页自己铺满到底，不留外层的 pb-6（来自 master） */
          activeSection === "chat" && "lg:pb-0",
        )}
      >
        <section
          className={cn(
            "lw-settings-shell",
            /*
             * lv-agent-settings-shell 用 margin-left:16px + 超宽容器，是为了给
             * 264px 侧边栏让位。没有侧边栏时沿用会让内容整体偏左，
             * 所以退回 lw-settings-shell 的居中布局。
             */
            !embedded && (hasSidebarLayout || shouldShowDataLoading) && "lv-agent-settings-shell",
          )}
        >
          {/* ── Loading 状态 ── */}
          {!isModifying && !(passesLoading && passesError) && shouldShowDataLoading && (
            <AgentSettingsDataLoading multiBotEnabled={multiBotEnabled} isChat={activeSection === "chat"} collapsed={isSidebarCollapsed} />
          )}

          {!isModifying && passesLoading && passesError && (
            <div role="alert" className="flex flex-col items-center gap-4 py-20 text-center">
              <p className="text-pretty text-sm text-[var(--text-secondary)]">{t("套餐列表加载失败")}</p>
              <Button type="button" variant="outline" onClick={() => void refreshPasses()}>{t("刷新状态")}</Button>
            </div>
          )}

          {/* ── 创建 Loading 动画 ── */}
          {!isModifying && !passesLoading && isCreating && !showEarlyOnboarding && !showMultiBotOnboarding && (
            <CreatingLoadingView errorMessage={creationError} />
          )}

          {/* ── 创建期前置引导：不干等实例，先让用户填资料 ── */}
          {/*
            排除 showMultiBotOnboarding：多 bot 引导正在进行时，这条分支不能
            接管。否则实例一进 provisioning、isCreating 转 true，渲染就从多 bot
            分支跳到这里 —— 两处位置不同，面板被重挂载、配置流程被取消。
          */}
          {!isModifying && !passesLoading && showEarlyOnboarding && !showMultiBotOnboarding && (
            <div className="_lh-claw-bot-panel__cards min-w-0">
              <AgentOnboardingPanel
                botId={earlyOnboardingBotId}
                profileId={earlyOnboardingProfileId}
                onCreated={handleBuddyCreated}
                execDebugCommand={repositories.bots.execDebugCommand}
                /* 点「创建」后挡住兜底 effect，别把正在写配置的面板卸载掉 */
                onSetupStart={() => { onboardingLockRef.current = true; }}
                /* 预填弹窗里刚填的 bot 名，避免用户重复输入 */
                initialName={provisioningBot?.name || createBotName}
              />
            </div>
          )}

          {isModifying && <AgentUpgradingView pass={upgradingPass} failed={passUpgradeFailed} paused={passUpgradePaused} refreshing={passUpgradeRefreshing} onRetry={retryPassUpgrade} />}

          {/*
            首个 bot 的创建引导。

            必须放在 `!isCreating && activeBot && sdkInstance` 那个分支之外：
            此时账号下还没有任何 bot，activeBot 为 null，放里面永远渲染不到 ——
            那条分支里的引导只服务「已有 bot 再建一个」的场景。

            显式排除 showEarlyOnboarding 与 isCreating：实例开始创建后就该交给
            创建期引导（它带 botId / profileId，能接着写配置），两个引导面板
            同时挂在页面上会出现两套表单。

            不传 cloneOptions：没有可复制的来源，引导页会隐藏「创建方式」
            那一档，addBot 收到空 sourceBotId 走 blank。

            条件只看 showMultiBotOnboarding 自己：
            原来还带 !isCreating && !showEarlyOnboarding，而这两个量会在本页
            建出 provisioning 实例后翻转（见「刷新恢复」effect），一翻转这个
            分支就消失、渲染跳到订阅分支，面板被重挂载、配置流程被取消。
            互斥性改由订阅分支上的 !showMultiBotOnboarding 单向保证。
          */}
          {showMultiBotOnboarding && !isModifying && (
            <div className="_lh-claw-bot-panel__cards min-w-0">
              <AgentOnboardingPanel
                botId=""
                onCreated={(createdBotId) => {
                  setShowMultiBotOnboarding(false);
                  // 带上新 bot 的 id，落到它自己的新会话页
                  handleBuddyCreated(createdBotId);
                }}
                onCreateBot={handleOnboardingCreateBot}
                execDebugCommand={repositories.bots.execDebugCommand}
                onSetupStart={() => { onboardingLockRef.current = true; }}
                /*
                 * 有可复制来源时才给 cloneOptions —— 首次订阅账号下还没有
                 * 任何 bot，给了会显示一个空下拉。
                 *
                 * 这里用 cloneSourceChoices.length 而不是 activeBot 判断：
                 * 前者在创建过程中只会「从无到有」地增加一项，不影响已挂载的
                 * 面板；用 activeBot 会导致整个分支切换、表单重置（见上面注释）。
                 */
                cloneOptions={cloneSourceChoices.length > 0
                  ? {
                    value: cloneSourceBotId,
                    onChange: setCloneSourceBotId,
                    choices: cloneSourceChoices,
                  }
                  : undefined}
              />
              {directCreateError ? (
                <p className="mt-3 text-center text-xs text-[#DC2626]">{directCreateError}</p>
              ) : null}
            </div>
          )}

          {/* ── 设置区域 ── */}
          {/*
            官网排除两个引导态；嵌入宿主在新建表单后保留当前 Bot 控制器。
            引导是「接管整页」的流程，而这块只看 !isCreating && activeBot ——
            多 bot 引导时 isCreating 为 false、activeBot 又存在（就是当前那个
            bot），于是配置进度清单和总览/设置区同屏显示（真实故障截图）。
          */}
          {!isCreating && (!showMultiBotOnboarding || embedded) && !showEarlyOnboarding && activeBot && sdkInstance && (
            (() => {
              type SettingsSectionLink = {
                id: AgentSettingsSectionId;
                label: string;
                icon: React.ReactNode;
                path: string;
                badge?: string;
              };
              const settingsGroups: { id: string; label: string; sections: SettingsSectionLink[] }[] = [
                {
                  id: "daily",
                  label: t("日常"),
                  sections: [
                    { id: "channel", label: resolveAgentConsoleCollectionLabel("channel", i18n.language, t), icon: <MessageCircle className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.channel },
                    { id: "skill", label: t("技能"), icon: <Wand2 className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.skill },
                    ...(showConnectorsEntry
                      ? [{ id: "connectors" as const, label: t("连接器"), icon: <Plug className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.connectors }]
                      : []),
                    { id: "automations", label: t("定时任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
                  ],
                },
                {
                  id: "growth",
                  label: t("成长"),
                  sections: [
                    { id: "buddy", label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
                    { id: "memory", label: t("持久记忆"), icon: <Database className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.memory },
                    { id: "achievement", label: t("成就"), icon: <Trophy className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.achievement },
                  ],
                },
                {
                  id: "manage",
                  label: t("管理"),
                  sections: [
                    { id: "model", label: resolveAgentConsoleCollectionLabel("model", i18n.language, t), icon: <BrainCircuit className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.model },
                    { id: "diagnostics", label: t("诊断中心"), icon: <Stethoscope className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.diagnostics },
                    { id: "settings", label: t("高级设置"), icon: <SlidersHorizontal className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.settings },
                  ],
                },
                {
                  id: "labs",
                  label: t("实验室"),
                  sections: [
                    {
                      id: "website",
                      label: t("我的工作台"),
                      icon: <Globe2 className="h-4 w-4" />,
                      path: AGENT_SECTION_PATH_BY_ID.website,
                      badge: "Beta",
                    },
                    {
                      id: "deepseek-harness",
                      label: "DeepSeek Harness",
                      icon: <FlaskConical className="h-4 w-4" />,
                      path: AGENT_SECTION_PATH_BY_ID["deepseek-harness"],
                      badge: "Beta",
                    },
                    // 云桌面入口守卫：仅在后端下发 cloudDesktopEnabled 的环境（已配置
                    // DESKTOP_INGRESS_DOMAIN，如 sandbox-bj-7）显示，现网隐藏避免死入口。
                    ...(cloudDesktopEnabled
                      ? [
                          {
                            id: "cloud-desktop",
                            label: t("云桌面"),
                            icon: <Monitor className="h-4 w-4" />,
                            path: AGENT_SECTION_PATH_BY_ID["cloud-desktop"],
                            badge: "Beta",
                          } as SettingsSectionLink,
                        ]
                      : []),
                  ],
                },
              ];
              const withCollapsedNavTooltip = (label: string, child: ReactNode, focusable = false) =>
                isDesktop && isSidebarCollapsed
                  ? <WorkspaceActionTooltip content={label} side="right" compact focusable={focusable}>{child}</WorkspaceActionTooltip>
                  : child;
              const renderSettingsGroup = (group: typeof settingsGroups[number]) => {
                const groupLabelId = `agent-settings-nav-group-${group.id}`;
                return (
                  <div
                    key={group.id}
                    className={cn("lv-agents-nav-group", group.id === "labs" && "lv-agents-nav-group--labs")}
                    role="group"
                    aria-labelledby={group.id === "daily" ? undefined : groupLabelId}
                    aria-label={group.id === "daily" ? group.label : undefined}
                  >
                    {group.id !== "daily" && <span id={groupLabelId} className="lv-agents-nav-group-label">{group.label}</span>}
                    <ul className="lv-agents-nav-group-items">
                      {group.sections.map((section) => {
                        const itemClass = cn(
                          "lw-settings-nav-item lv-agents-nav-item",
                          section.badge && "has-badge",
                          section.id === activeSection ? "is-active" : "text-black/70 hover:bg-black/[0.025]",
                        );
                        const content = <>
                          <span className="lv-agents-nav-icon">{section.icon}</span>
                          <span className={cn("min-w-0 flex-1 text-left", section.badge ? "whitespace-normal lg:whitespace-nowrap" : "whitespace-nowrap")}>{section.label}</span>
                          {section.badge && <span className="shrink-0 rounded-full border border-black/[0.08] bg-black/[0.025] px-1.5 py-0.5 text-[9px] font-bold leading-none text-black/45">{section.badge}</span>}
                        </>;
                        return <li key={section.id}>
                          {withCollapsedNavTooltip(
                            showBuddyOnboarding ? t("请先创建你的个人助手") : section.label,
                            showBuddyOnboarding ? (
                              <span aria-disabled="true" tabIndex={isDesktop && isSidebarCollapsed ? 0 : undefined} title={!isSidebarCollapsed ? t("请先创建你的个人助手") : undefined}
                                className={cn(itemClass, "cursor-not-allowed opacity-40")}>{content}</span>
                            ) : (
                              <AppLink to={getAgentSectionHref(section.path, searchParams)}
                              aria-label={section.label}
                              aria-current={section.id === activeSection ? "page" : undefined}
                              onClick={() => setMobileChatNavOpen(false)}
                              className={itemClass}>{content}</AppLink>
                            ),
                          )}
                        </li>;
                      })}
                    </ul>
                  </div>
                );
              };
              const isRestartDisabled = resettingAcli || isActiveBotRestarting || activeBot.status !== "running";
              const isRepairingBot = repairingBotIds.has(activeBot.id);
              const restartTooltip = activeBot.status === "failed" ? t("修复 Bot") : t("重启");
              const pausedStatusTooltip = activeBot.status === "paused"
                ? t("Agent 已暂停运行。如因套餐到期，续费后即可恢复使用。")
                : undefined;
              const restartOrRepairDisabled = activeBot.status === "failed" ? isRepairingBot : isRestartDisabled;
              const resetBlockReason = getResetBlockReason(activeBot, resetting);
              const resetDisabled = botsLoading || maintenanceBusy || resetBlockReason !== null;
              const resetTooltip = maintenanceBusy || resetBlockReason === RESET_BLOCK_REASON.NOT_RUNNING
                  ? t("请稍后")
                  : t("重置模型配置");
              const acliResetBlockReason = getAcliResetBlockReason(activeBot, resettingAcli);
              const acliResetDisabled = !isActiveBotDefault || maintenanceBusy || acliResetBlockReason !== null;
              const acliResetTooltip =
                acliResetBlockReason === RESET_BLOCK_REASON.NOT_RUNNING
                  ? t("请稍后")
                  : t("重置 Hermes（保留数据）");
              const deleteRequiresOtherBotsRemoved = Boolean(activeBot.isDefault && remainingInstanceBotCount > 0);
              const deleteDisabled = resettingAcli || deleteRequiresOtherBotsRemoved;
              const deleteLabel = activeBot.isDefault ? t("删除整个 Agent") : t("删除 Bot");
              const deleteTooltip = deleteRequiresOtherBotsRemoved
                ? t("请先删除其他 Bot，再删除主 Bot")
                : deleteLabel;
              const deleteDisabledReason = deleteRequiresOtherBotsRemoved
                ? deleteTooltip
                : resettingAcli ? t("请稍后") : undefined;
              const sectionFallback = TEA_SDK_SECTIONS.has(activeSection)
                ? null
                : (
                  <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-black/[0.06] bg-white text-sm text-black/45">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("正在加载页面…")}
                  </div>
                );
              const activeBotDisplayName = resolveAgentDisplayName(activeBot.name, t);
              /* 走过本引导（SOUL 里有自定义头像字段）才用几何体头像与 SOUL 名字，
                 否则回落原有的 bot 头像与名称。 */
              const demoProfileIsCustom = buddyProfileState.hasBuddyConfig === true;
              const agentProfileDisplayName = demoProfileIsCustom
                ? buddyProfileState.profile.name
                : activeBotDisplayName;
              const mobileSectionLabel = activeSection === "chat"
                ? t("对话")
                : settingsGroups.flatMap((group) => group.sections).find((section) => section.id === activeSection)?.label ?? activeBotDisplayName;
              const botContextActions = <span className="lv-agent-bot-context-actions">
                <Popover key={activeBot.id}>
                  <PopoverTrigger asChild>
                    <button type="button" className="lv-agent-bot-context-trigger" aria-label={t("管理 Bot")} data-tooltip={t("管理 Bot")}>
                      <Settings2 className="h-[18px] w-[18px]" aria-hidden="true" />
                      {activeBotRestartError && <span className="absolute right-0 top-0 size-1.5 rounded-full bg-red-500" aria-hidden="true" />}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="right" align="end" sideOffset={8} className="w-52 rounded-md p-1.5">
                    <div className="truncate px-2 py-1.5 text-xs text-black/45" title={agentProfileDisplayName}>{agentProfileDisplayName}</div>
                    {activeBotRestartError && <p role="alert" className="px-2 py-1 text-xs leading-relaxed text-red-500">{activeBotRestartError}</p>}
                    <button type="button" className="lv-sidebar-user-menu-item w-full" disabled={activeBot.status !== "running" || !activeBot.profileId?.trim() || buddyProfileState.loading || buddyProfileState.soulExists === null} onClick={() => setProfileEditorOpen(true)}>
                      <Wand2 className="size-4" aria-hidden="true" />{t("修改资料")}
                    </button>
                    <button type="button" className="lv-sidebar-user-menu-item w-full" disabled={!canCreateAdditionalBot || activeBot.status !== "running" || !activeBot.profileId?.trim()} onClick={handleCloneBot}>
                      <Copy className="size-4" aria-hidden="true" />{t("复制 Bot")}
                    </button>
                    <div className="my-1 border-t border-black/[0.06]" />
                    <button type="button" className="lv-sidebar-user-menu-item w-full" disabled={restartOrRepairDisabled}
                      title={restartOrRepairDisabled ? t("请稍后") : undefined}
                      onClick={() => {
                        if (activeBot.status === "failed") void handleRetryBot();
                        else setShowRestartConfirm(true);
                      }}>
                      {isActiveBotRestarting || isRepairingBot ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                      {restartTooltip}
                    </button>
                    <WorkspaceActionTooltip content={deleteDisabledReason} side="right" className="w-full">
                      <button type="button" className="lv-sidebar-user-menu-item lv-agent-bot-menu-delete w-full" disabled={deleteDisabled}
                        onClick={() => {
                          setDeleteTargetBot(null);
                          setDeleteInput("");
                          setShowDeleteConfirm(true);
                        }}>
                        <Trash2 className="size-4" aria-hidden="true" />{deleteLabel}
                      </button>
                    </WorkspaceActionTooltip>
                  </PopoverContent>
                </Popover>
              </span>;
              return (
                <Fragment>
                <AgentConsoleHostProjection host={consoleHost} state={{
                  type: "bot-console-state", botId: activeBot.id, section: activeSection,
                  groups: settingsGroups.map(group => ({ id: group.id, label: group.label,
                    sections: group.sections.map(item => ({ id: item.id, label: item.label })) })),
                  sessions: chatSessionPagination.visibleSessions.map(session => ({
                    chatId: session.chatId, title: (session.title || t("新对话")).slice(0, 256),
                    pinned: "pinned" in session && session.pinned === true,
                    unread: unreadChatIds.includes(session.chatId),
                  })),
                  selectedChatId: selectedChatId ?? null,
                  loading: chatSessionsLoading,
                  hasMore: chatSessionPagination.hasMoreVisible || chatSessionsHasMore,
                  commandsReady: chatSessionCommands !== null && isActiveBotChatAvailable,
                  pinSupported: chatPinSupported,
                  pending: chatSessionMutationState?.pending === true || chatSessionPagination.loadingMore,
                  error: chatSessionMutationState?.error != null || chatPinError !== null || chatSessionPagination.pageError,
                }} onCommand={command => {
                  if (command.type === "select" && command.botId !== activeBot.id && visibleBots.some(bot => bot.id === command.botId)) {
                    handleSelectBot(command.botId);
                    return true;
                  }
                  if (command.type !== "session" || command.botId !== activeBot.id) return false;
                  if (chatSessionMutationState?.pending || chatSessionCommands === null) return true;
                  switch (command.action) {
                    case "create":
                      navigate(getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.chat, activeBot.id));
                      createChatSession(); break;
                    case "load-more": void chatSessionPagination.showMore(); break;
                    case "select":
                      if (command.chatId === "" || chatSessions.some(session => session.chatId === command.chatId)) {
                        setSelectedChatId(command.chatId);
                        setUnread(command.chatId, false);
                        navigate(getAgentBotSectionHref(AGENT_SECTION_PATH_BY_ID.chat, activeBot.id));
                      }
                      break;
                    case "rename":
                      if (chatSessions.some(session => session.chatId === command.chatId)) chatSessionActions?.renameSession(command.chatId, command.title.trim());
                      break;
                    case "delete": {
                      const session = chatSessions.find(session => session.chatId === command.chatId);
                      if (session && canDeleteSession(session)) chatSessionActions?.deleteSession(command.chatId);
                      break;
                    }
                    case "pin": {
                      const session = chatSessions.find(session => session.chatId === command.chatId);
                      if (session && ("pinned" in session && session.pinned === true) !== command.pinned) toggleSessionPin(session);
                      break;
                    }
                    case "unread": if (chatSessions.some(session => session.chatId === command.chatId)) markSessionUnread(command.chatId); break;
                  }
                  return true;
                }} />
                <div
                  hidden={showMultiBotOnboarding}
                  inert={showMultiBotOnboarding || undefined}
                  style={showMultiBotOnboarding ? { display: "none" } : undefined}
                  className={cn(
                    /* lv-agent-settings-grid 来自 master，勿删 */
                    "lv-agent-settings-grid grid items-start",
                    multiBotEnabled && "lg:gap-x-0",
                    activeSection === "chat" && openCraftChatEnabled ? "gap-y-0 lg:gap-y-6" : "gap-6",
                    /* 引导态不给侧边栏留列，内容区自己撑满并居中 */
                    hasSidebarLayout && !embedded && (multiBotEnabled
                      ? (isSidebarCollapsed ? "lg:grid-cols-[56px_56px_minmax(0,1fr)]" : "lg:grid-cols-[56px_216px_minmax(0,1fr)]")
                      : (isSidebarCollapsed ? "lg:grid-cols-[56px_minmax(0,1fr)]" : "lg:grid-cols-[248px_minmax(0,1fr)]")),
                  )}
                >
                  {/* 引导态隐藏整个侧边栏：新用户先专注建伙伴，
                      配置完成后导航才出现（避免一进来就面对点不了的入口） */}
                  {hasSidebarLayout && !embedded ? (
                  <>
                      {isDesktop && multiBotEnabled && <AgentBotRail bots={visibleBots} activeBotId={activeBot.id} canCreate={nativeCreateEnabled} createLimitMessage={createLimitMessage || ""} profileRevision={botRailProfileRevision} restartingBotIds={restartingBotIds} execDebugCommand={repositories.bots.execDebugCommand} onSelect={handleSelectBot} onCreate={handleCreateNew} manageActions={botContextActions} />}
                      <div className="lv-agent-mobile-toolbar">
                        <button
                          ref={mobileNavTriggerRef}
                          type="button"
                          className="lv-agent-chat-mobile-nav-toggle"
                          aria-label={mobileChatNavOpen ? t("收起导航") : t("展开导航")}
                          aria-controls="lv-agent-sidebar-navigation"
                          aria-expanded={mobileChatNavOpen}
                          onClick={() => setMobileChatNavOpen(true)}
                        >
                          <PanelLeft className="size-5" aria-hidden="true" />
                        </button>
                        <div className="lv-agent-mobile-toolbar-copy">
                          <span className="lv-agent-mobile-toolbar-section">{mobileSectionLabel}</span>
                          {activeSection === "chat" && <span className="lv-agent-mobile-toolbar-bot">{agentProfileDisplayName}</span>}
                        </div>
                      </div>
                      {mobileChatNavOpen && (
                        <button
                          type="button"
                          className="lv-agent-chat-mobile-nav-backdrop"
                          aria-label={t("关闭")}
                          onClick={() => setMobileChatNavOpen(false)}
                        />
                      )}
                  <AgentSidebar
                    role={!isDesktop && mobileChatNavOpen ? "dialog" : undefined}
                    aria-modal={!isDesktop && mobileChatNavOpen ? true : undefined}
                    aria-label={!isDesktop && mobileChatNavOpen ? t("侧边栏视图切换") : undefined}
                    onClickCapture={(event) => {
                      if ((event.target as HTMLElement).closest("a")) setMobileChatNavOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (isDesktop || !mobileChatNavOpen || event.key !== "Tab") return;
                      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled)"));
                      const first = focusable[0];
                      const last = focusable[focusable.length - 1];
                      if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last?.focus();
                      } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                      }
                    }}
                  >
                      <button
                        ref={mobileNavCloseRef}
                        type="button"
                        className="lv-agent-chat-mobile-nav-close"
                        aria-label={t("关闭")}
                        onClick={() => setMobileChatNavOpen(false)}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    {!isDesktop && multiBotEnabled && <AgentBotRail mobile bots={visibleBots} activeBotId={activeBot.id} canCreate={nativeCreateEnabled} createLimitMessage={createLimitMessage || ""} profileRevision={botRailProfileRevision} restartingBotIds={restartingBotIds} execDebugCommand={repositories.bots.execDebugCommand} onSelect={handleSelectBot} onCreate={handleCreateNew} />}
                    {(!isDesktop || !multiBotEnabled) && <div className="lv-agents-sidebar-profile">
                      <div className="lv-agent-profile-row">
                      <div className="lv-agent-profile-wrap">
                            <div
                              className="lv-agent-profile cursor-default"
                              aria-label={`${agentProfileDisplayName}，${isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}`}
                              title={isSidebarCollapsed ? agentProfileDisplayName : undefined}
                            >
                              {/* Demo：头像与名称跟随新手引导里设置的资料（几何体头像）；
                                  未设置过时回落到原有的 bot 头像与名称。 */}
                              {!multiBotEnabled && <span className="lv-agent-avatar lv-agent-avatar--status">
                                {demoProfileIsCustom ? (
                                  <GeometricAvatar
                                    shapeId={buddyProfileState.profile.shapeId}
                                    color={buddyProfileState.profile.color}
                                    size={32}
                                  />
                                ) : (
                                  <img src={avatarUrl} alt="" />
                                )}
                                <span
                                  className={cn(
                                    "lv-agent-avatar-status",
                                    !isActiveBotRestarting && ["provisioning", "deleting", "draft"].includes(activeBot.status) && "lv-agent-avatar-status--blinking",
                                  )}
                                  role="img"
                                  aria-label={isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}
                                  title={isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}
                                  style={{ background: isActiveBotRestarting ? "#FF9500" : getBotStatusColor(activeBot.status) }}
                                />
                              </span>}
                              <span className="lv-agent-profile-text">
                                <span className="lv-agent-profile-name" title={agentProfileDisplayName}>
                                  {truncateBotName(agentProfileDisplayName)}
                                </span>
                                {(isActiveBotRestarting || activeBot.status !== "running" || (passExpiryReminder && passExpiryReminderCopy && activePass)) && <span className="lv-agent-status-row">
                                  {(isActiveBotRestarting || activeBot.status !== "running") && (
                                    <WorkspaceActionTooltip content={pausedStatusTooltip} side="bottom">
                                      <span className="lv-agent-status">
                                        {isActiveBotRestarting ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : null}
                                        {isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}
                                      </span>
                                    </WorkspaceActionTooltip>
                                  )}
                                  {passExpiryReminder && passExpiryReminderCopy && activePass && (
                                    renewalAvailable ? (
                                      <span className="group relative inline-flex">
                                        <button
                                          type="button"
                                          className={cn("lv-agent-renewal-badge cursor-pointer", `is-${passExpiryReminder.level}`)}
                                          aria-label={t("套餐{{time}}，点击续费", { time: passExpiryReminderCopy.tooltip })}
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
                                          {passExpiryReminderCopy.label}
                                        </button>
                                        <span className="pointer-events-none absolute top-full left-1/2 z-20 -translate-x-1/2 pt-2 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                          <span
                                            id={passExpiryTooltipId}
                                            role="tooltip"
                                            className="pointer-events-auto relative whitespace-nowrap rounded-[6px] border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-black/80 shadow-[0_8px_24px_rgba(15,23,42,0.12)] select-text"
                                          >
                                            {passExpiryReminderCopy.tooltip}
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
                                              className="absolute bottom-full left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rotate-45 border-l border-t border-[var(--border-subtle)] bg-white"
                                            />
                                          </span>
                                        </span>
                                      </span>
                                    ) : (
                                      <span
                                        className={cn(
                                          "lv-agent-renewal-badge is-disabled",
                                          `is-${passExpiryReminder.level}`,
                                        )}
                                      >
                                        {passExpiryReminderCopy.label}
                                        <span className="sr-only"> {passExpiryReminderCopy.tooltip}</span>
                                      </span>
                                    )
                                  )}
                                </span>}
                              </span>
                              <div
                                className="lv-agent-actions"
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.stopPropagation();
                                  }
                                }}
                              >
                                <WorkspaceActionTooltip content={restartTooltip} side="bottom" compact focusable={false}>
                                  <button
                                    type="button"
                                    aria-label={restartTooltip}
                                    disabled={restartOrRepairDisabled}
                                    className="lv-agent-action-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (restartOrRepairDisabled) return;
                                      if (activeBot.status === "failed") {
                                        void handleRetryBot();
                                        return;
                                      }
                                      setShowRestartConfirm(true);
                                    }}
                                  >
                                    {isActiveBotRestarting || isRepairingBot ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                    ) : activeBot.status === "failed" ? (
                                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                    ) : (
                                      <RestartIcon className="h-4 w-4" />
                                    )}
                                  </button>
                                </WorkspaceActionTooltip>
                                <WorkspaceActionTooltip content={deleteTooltip} side="bottom" compact focusable={false}>
                                  <button
                                    type="button"
                                    aria-label={deleteTooltip}
                                    disabled={deleteDisabled}
                                    className="lv-agent-action-button is-danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (deleteDisabled) return;
                                      setDeleteTargetBot(null);
                                      setDeleteInput("");
                                      setShowDeleteConfirm(true);
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                  </button>
                                </WorkspaceActionTooltip>
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button type="button" className="lv-agent-action-button" aria-label={t("管理 Bot")}>
                                      <MoreVertical className="h-4 w-4" aria-hidden="true" />
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent side="bottom" align="end" className="w-44 rounded-md p-1.5">
                                    <button type="button" className="lv-sidebar-user-menu-item w-full" disabled={activeBot.status !== "running" || !activeBot.profileId?.trim() || buddyProfileState.loading || buddyProfileState.soulExists === null} onClick={() => setProfileEditorOpen(true)}>
                                      <Wand2 className="size-4" aria-hidden="true" />{t("修改资料")}
                                    </button>
                                    <button type="button" className="lv-sidebar-user-menu-item w-full" disabled={!canCreateAdditionalBot || activeBot.status !== "running" || !activeBot.profileId?.trim()} onClick={handleCloneBot}>
                                      <Copy className="size-4" aria-hidden="true" />{t("复制 Bot")}
                                    </button>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            </div>

                        {activeBotRestartError && (
                          <p className="mt-2 px-1 text-xs leading-relaxed text-red-500">{activeBotRestartError}</p>
                        )}
                      </div>
                      </div>

                    </div>}
                    <div className="lv-agents-sidebar-controls">
                      {/* ── 日常与探索共用当前 Bot，切换时恢复各栏最近页面 ── */}
                      <div className="lv-agents-sidebar-tabs" role="tablist" aria-label={t("侧边栏视图切换")}>
                        {withCollapsedNavTooltip(t("日常"),
                        <button
                          type="button"
                          role="tab"
                          aria-selected={sidebarTab === "daily"}
                          aria-label={t("日常")}
                          className={cn("lv-agents-sidebar-tab", sidebarTab === "daily" && "is-active")}
                          onClick={handleSidebarDailyTabClick}
                        >
                          <House className="lv-agents-sidebar-tab-icon size-4" aria-hidden="true" />
                          <span className="lv-agents-sidebar-tab-label">{t("日常")}</span>
                        </button>)}
                        {withCollapsedNavTooltip(t("探索"),
                        <button
                          type="button"
                          role="tab"
                          aria-selected={sidebarTab === "explore"}
                          aria-label={t("探索")}
                          disabled={showBuddyOnboarding}
                          className={cn("lv-agents-sidebar-tab", sidebarTab === "explore" && "is-active")}
                          onClick={handleSidebarExploreTabClick}
                        >
                          <LayoutDashboard className="lv-agents-sidebar-tab-icon size-4" aria-hidden="true" />
                          <span className="lv-agents-sidebar-tab-label">{t("探索")}</span>
                        </button>, showBuddyOnboarding)}
                      </div>
                    </div>
                    <div className="lv-agents-sidebar-middle">
                      <div className="flow-root">
                        {sidebarTab === "daily" ? (
                          <nav className="lv-agents-nav" aria-label={t("日常")}>
                            {settingsGroups.filter((group) => group.id === "daily").map(renderSettingsGroup)}
                            {openCraftChatEnabled && <div className="lv-agents-nav-group lv-agents-chat-group" role="group" aria-label={t("对话")}>
                              {isSidebarCollapsed ? (
                                isChatTabDisabled ? (
                                  <WorkspaceActionTooltip
                                    content={t("请先创建你的个人助手")}
                                    side="right"
                                    focusable
                                  >
                                    <span aria-disabled="true" tabIndex={0} className="lw-settings-nav-item lv-agents-nav-item cursor-not-allowed opacity-40">
                                      <span className="lv-agents-nav-icon"><MessageSquare className="h-4 w-4" aria-hidden="true" /></span>
                                      <span>{t("对话")}</span>
                                    </span>
                                  </WorkspaceActionTooltip>
                                ) : withCollapsedNavTooltip(t("对话"),
                                  <AppLink to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.chat, searchParams)}
                                    onClick={() => setMobileChatNavOpen(false)}
                                    aria-label={t("对话")}
                                    className={cn("lw-settings-nav-item lv-agents-nav-item", activeSection === "chat" && "is-active")}
                                  >
                                    <span className="lv-agents-nav-icon"><MessageSquare className="h-4 w-4" /></span>
                                    <span>{t("对话")}</span>
                                  </AppLink>
                                )
                              ) : (
                                <div className="lv-agents-chat-header">
                                  {isChatTabDisabled ? (
                                    <WorkspaceActionTooltip
                                      content={t("请先创建你的个人助手")}
                                      side="bottom"
                                      focusable
                                    >
                                      <span aria-disabled="true" tabIndex={0} className="lv-agents-chat-toggle cursor-not-allowed opacity-40">
                                        <span>{t("对话")}</span>
                                        <ChevronDown className="size-4" aria-hidden="true" />
                                      </span>
                                    </WorkspaceActionTooltip>
                                  ) : (
                                    <button
                                      type="button"
                                      className="lv-agents-chat-toggle"
                                      aria-expanded={chatSessionsExpanded}
                                      onClick={() => setChatSessionsExpanded((expanded) => !expanded)}
                                    >
                                      <span>{t("对话")}</span>
                                      <ChevronDown className={cn("size-4 transition-transform", chatSessionsExpanded && "rotate-180")} aria-hidden="true" />
                                    </button>
                                  )}
                                  <WorkspaceActionTooltip content={t("新建对话")} compact focusable={false} className="shrink-0">
                                    <button
                                      type="button"
                                      className="lv-agents-chat-create"
                                      aria-label={t("新建对话")}
                                      disabled={isChatTabDisabled || chatSessionMutationState?.pending === true || (activeSection === "chat" && chatSessionCommands === null)}
                                      onClick={() => {
                                        setMobileChatNavOpen(false);
                                        setChatSessionsExpanded(true);
                                        if (activeSection === "chat") createChatSession();
                                        else {
                                          pendingNewChatSessionBotId = activeBot.id;
                                          navigate(getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.chat, searchParams));
                                        }
                                      }}
                                    >
                                      <Plus className="size-4" aria-hidden="true" />
                                    </button>
                                  </WorkspaceActionTooltip>
                                </div>
                              )}
                              {!isChatTabDisabled && chatSessionsExpanded && !isSidebarCollapsed ? <>
                              <ul className="lv-agents-nav-group-items lv-agents-session-list">
                                {emptyChatSessionState === "loading" ? (
                                  <li className="sr-only" role="status">{isGlobal ? t("正在加载会话…") : t("正在加载...")}</li>
                                ) : emptyChatSessionState === "default" ? (
                                  /*
                                   * 首次读取尚未完成时由 loading 分支承接；确认空列表后
                                   * 才显示默认对话入口。实例不支持会话协议（SDK 5s 超时）
                                   * 也可合法回落到单会话形态，不阻断进入聊天页。
                                   * 要区分需看 WebSocket 有无 chat:response，不是 UI 的职责。
                                   */
                                  <li>
                                    <AppLink
                                      to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.chat, searchParams)}
                                      onClick={() => setMobileChatNavOpen(false)}
                                      aria-current={activeSection === "chat" ? "page" : undefined}
                                      title={isSidebarCollapsed ? t("默认对话") : undefined}
                                      className={cn(
                                        "lv-agents-session-item lv-agents-nav-item",
                                        activeSection === "chat" && "is-active",
                                      )}
                                    >
                                      <span className="lv-agents-session-title" title={t("默认对话")}>
                                        {t("默认对话")}
                                      </span>
                                    </AppLink>
                                  </li>
                                ) : (
                                  chatSessionPagination.visibleSessions.map((session, index) => {
                                    const isSelected = selectedChatId === session.chatId;
                                    const isUnread = unreadChatIds.includes(session.chatId);
                                    const isPinned = "pinned" in session && session.pinned === true;
                                    const isPinning = pinningChatIds.has(session.chatId);
                                    const isRenaming = renamingChatId === session.chatId;
                                    const isMenuOpen = openSessionMenuChatId === session.chatId;
                                    const isDeletable = canDeleteSession(session);
                                    const isRunning = "running" in session && session.running === true;
                                    const sessionDisplayTitle = resolveAgentSessionTitle(
                                      session.title,
                                      i18n.language,
                                      t("默认会话"),
                                    );
                                    return (
                                      <Fragment key={session.chatId}>
                                      {chatSessionPagination.pinnedCount > 0 && index === 0 ? (
                                        <li className="lv-agents-session-group-label">
                                          {locale.startsWith("zh") ? t("置顶") : t("已置顶")}
                                        </li>
                                      ) : null}
                                      {chatSessionPagination.pinnedCount > 0 && index === chatSessionPagination.pinnedCount ? (
                                        <li className="lv-agents-session-group-label">{t("最近对话")}</li>
                                      ) : null}
                                      <li className="lv-agents-session-item-wrap">
                                        {isRenaming ? (
                                          <input
                                            className="lv-agents-session-rename-input"
                                            value={renamingDraft}
                                            autoFocus
                                            aria-label={t("会话名称")}
                                            title={t("回车确认，Esc 取消")}
                                            onChange={(event) => setRenamingDraft(event.target.value)}
                                            onBlur={() => commitSessionRename()}
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter") {
                                                event.preventDefault();
                                                commitSessionRename();
                                              } else if (event.key === "Escape") {
                                                event.preventDefault();
                                                cancelSessionRename();
                                              }
                                            }}
                                          />
                                        ) : (
                                          <>
                                            <AppLink
                                              to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.chat, searchParams)}
                                              aria-current={isSelected ? "page" : undefined}
                                              aria-label={isUnread ? `${sessionDisplayTitle} (${t("未读")})` : sessionDisplayTitle}
                                              title={isSidebarCollapsed ? sessionDisplayTitle : undefined}
                                              onClick={() => {
                                                setSelectedChatId(session.chatId);
                                                setUnread(session.chatId, false);
                                                setMobileChatNavOpen(false);
                                              }}
                                              className={cn(
                                                "lv-agents-session-item lv-agents-nav-item",
                                                openCraftChatEnabled && "lv-agents-session-item--opencraft",
                                                isRunning && "lv-agents-session-item--running",
                                                isUnread && "lv-agents-session-item--unread",
                                                isSelected && "is-active",
                                              )}
                                            >
                                              <span className="lv-agents-session-title" title={sessionDisplayTitle}>
                                                {sessionDisplayTitle}
                                              </span>
                                              {isUnread ? <span className="lv-agents-session-unread-dot" aria-hidden="true" /> : null}
                                            </AppLink>
                                            <div ref={isMenuOpen ? sessionMenuRef : undefined} className="lv-agents-session-menu-anchor">
                                              {isRunning ? <span className="lv-agents-session-running" role="img" aria-label={t("执行中")} /> : null}
                                              <button
                                                type="button"
                                                className="lv-agents-session-menu-btn"
                                                aria-label={t("会话操作")}
                                                aria-expanded={isMenuOpen}
                                                aria-busy={isPinning || undefined}
                                                disabled={isPinning}
                                                onClick={(event) => {
                                                  event.preventDefault();
                                                  event.stopPropagation();
                                                  setOpenSessionMenuChatId(isMenuOpen ? null : session.chatId);
                                                }}
                                              >
                                                {isPinning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
                                              </button>
                                              {isMenuOpen ? (
                                                <div className="lv-agents-session-menu" role="menu">
                                                  {chatPinSupported && chatSessionCommands && session.chatId !== "" ? <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="lv-agents-session-menu-item"
                                                    disabled={isPinning}
                                                    onClick={() => toggleSessionPin(session)}
                                                  >
                                                    {isPinned ? t("取消置顶") : t("置顶")}
                                                  </button> : null}
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="lv-agents-session-menu-item"
                                                    disabled={!chatSessionActions || chatSessionMutationState?.pending === true}
                                                    onClick={() => startSessionRename(session)}
                                                  >
                                                    {t("重命名")}
                                                  </button>
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="lv-agents-session-menu-item"
                                                    onClick={() => markSessionUnread(session.chatId)}
                                                  >
                                                    {t("标记为未读")}
                                                  </button>
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="lv-agents-session-menu-item lv-agents-session-menu-item--danger"
                                                    disabled={!chatSessionActions || chatSessionMutationState?.pending === true || !isDeletable}
                                                    title={isDeletable ? undefined : t("默认会话不支持删除")}
                                                    onClick={() => openSessionDeleteConfirm(session)}
                                                  >
                                                    {t("删除")}
                                                  </button>
                                                </div>
                                              ) : null}
                                            </div>
                                          </>
                                        )}
                                      </li>
                                      {chatPinError === session.chatId ? <li className="lv-agents-session-hint lv-agents-session-hint--error" role="alert">{t("置顶操作失败，请重试")}</li> : null}
                                      </Fragment>
                                    );
                                  })
                                )}
                                {chatSessions.length > 0 && (chatSessionPagination.hasMoreVisible || chatSessionPagination.hasExpanded) ? (
                                  <li className="lv-agents-session-list-actions">
                                    {chatSessionPagination.hasMoreVisible ? (
                                      <button type="button" disabled={chatSessionPagination.loadingMore || (chatSessionsHasMore && !chatSessionCommands?.loadMoreSessions)} aria-busy={chatSessionPagination.loadingMore} onClick={() => { void chatSessionPagination.showMore(); }}>
                                        {t("查看更多")}
                                      </button>
                                    ) : null}
                                    {chatSessionPagination.hasExpanded ? (
                                      <button type="button" disabled={chatSessionPagination.loadingMore} onClick={chatSessionPagination.collapse}>
                                        {t("收起")}
                                      </button>
                                    ) : null}
                                  </li>
                                ) : null}
                              </ul>
                              {chatSessionPagination.pageError ? <p className="lv-agents-session-hint" role="alert">{t("会话加载失败，请重试")}</p> : null}
                              {chatSessionMutationState !== null ? (
                                <p
                                  className={cn(
                                    "lv-agents-session-hint",
                                    chatSessionMutationState.error !== null && "text-red-600",
                                  )}
                                  role={chatSessionMutationState.error !== null ? "alert" : "status"}
                                >
                                  {chatSessionMutationState.error ?? (
                                    chatSessionMutationState.operation === "create"
                                      ? t("正在创建新会话…")
                                      : chatSessionMutationState.operation === "rename"
                                        ? t("正在重命名会话…")
                                        : t("正在删除会话…")
                                  )}
                                </p>
                              ) : null}
                              </> : null}
                            </div>}
                          </nav>
                        ) : (
                          <nav
                            aria-label={t("探索")}
                            className="lv-agents-nav"
                          >
                            {showHiddenAgentTools ? (
                              <div className="lv-agents-nav-group">
                                <ul className="lv-agents-nav-group-items">
                                  <li>
                                    {withCollapsedNavTooltip(t("终端"),
                                    <AppLink
                                      to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.terminal, searchParams)}
                                      aria-current={activeSection === "terminal" ? "page" : undefined}
                                      aria-label={t("终端")}
                                      className={cn(
                                        "lw-settings-nav-item lv-agents-nav-item",
                                        activeSection === "terminal"
                                          ? "is-active"
                                          : "text-black/70 hover:bg-black/[0.025]",
                                      )}
                                    >
                                      <span className="lv-agents-nav-icon"><TerminalSquare className="h-4 w-4" /></span>
                                      <span className="flex-1 text-left">{t("终端")}</span>
                                    </AppLink>)}
                                  </li>
                                  <li>
                                    {withCollapsedNavTooltip(t("浏览器"),
                                    <AppLink
                                      to={getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.browser, searchParams)}
                                      aria-current={activeSection === "browser" ? "page" : undefined}
                                      aria-label={t("浏览器")}
                                      className={cn(
                                        "lw-settings-nav-item lv-agents-nav-item",
                                        activeSection === "browser"
                                          ? "is-active"
                                          : "text-black/70 hover:bg-black/[0.025]",
                                      )}
                                    >
                                      <span className="lv-agents-nav-icon"><Globe2 className="h-4 w-4" /></span>
                                      <span className="flex-1 text-left">{t("浏览器")}</span>
                                    </AppLink>)}
                                  </li>
                                </ul>
                              </div>
                            ) : null}
                            {settingsGroups.filter((group) => group.id !== "daily").map(renderSettingsGroup)}
                          </nav>
                        )}

                      </div>
                    </div>
                    <div className="lv-agents-sidebar-footer">
                      <div className="lv-agent-account-footer">
                        {(isDesktop || mobileChatNavOpen) && (
                          <UserAvatarMenu showLanguageSwitcher={isGlobal} variant="sidebar" cloudStorageBotId={activeSection === "files" ? undefined : activeBot?.id}
                            renewalReminder={isDesktop && multiBotEnabled && passExpiryReminder && passExpiryReminderCopy && activePass
                              ? { label: passExpiryReminderCopy.label, tooltip: passExpiryReminderCopy.tooltip, actionLabel: t("立即续费"),
                                  onRenew: renewalAvailable ? () => setRenewPassModalOpen(true) : undefined }
                              : undefined} />
                        )}
                      </div>
                    </div>
                  </AgentSidebar>
                  </>
                  ) : null}

                  {profileEditorOpen && activeBot && (
                    <Suspense fallback={null}>
                      <AgentBotProfileEditor
                        key={activeBot.id}
                        botId={activeBot.id}
                        profileId={activeBot.profileId}
                        profile={buddyProfileState.profile}
                        execDebugCommand={repositories.bots.execDebugCommand}
                        onClose={() => setProfileEditorOpen(false)}
                        onChanged={() => {
                          buddyProfileState.reload();
                          setBotRailProfileRevision((revision) => revision + 1);
                          void refreshBots();
                          if (embedded) window.dispatchEvent(new CustomEvent("opencraft-mobile-bot-profile-changed", { detail: activeBot.id }));
                        }}
                      />
                    </Suspense>
                  )}

                  <section
                    className={cn(
                      "lv-agent-settings-content min-w-0",
                      /* 多 Bot 时占第三列；单 Bot 时占第二列；引导态没有侧边栏 */
                      hasSidebarLayout && !embedded
                        ? (multiBotEnabled ? "lg:col-start-3 lg:pl-6" : "lg:col-start-2")
                        : "mx-auto w-full max-w-[860px]",
                    )}
                  >
                    {/*
                      多 bot 创建引导已统一到设置区之前那一个挂载点。

                      这里原本还有一份（条件 `showMultiBotOnboarding && activeBot`），
                      与那边的 `!activeBot` 互补 —— 本意是「没有 bot 时用外面那个、
                      已有 bot 时用这个」。但两处在 DOM 树里位置不同，activeBot 一旦
                      在创建过程中从空变为真值（新 bot 转 running 进入 visibleBots），
                      React 就会卸载一个、挂载另一个：AgentOnboardingPanel 的 phase
                      重置回 "form"，用户填完表单后又被扔回创建表单，写配置的 effect
                      也被 cleanup 中断。

                      现在只保留一个挂载点，条件不含 activeBot，创建全程都是同一个
                      组件实例，不会重挂载。
                    */}
                    {/*
                      key 不含 activeSection：各分区面板本身就按 activeSection 条件渲染、
                      切换时自行卸载，而嵌入式 Chat Surface 是容器内唯一无条件渲染的子节点。
                      一旦 key 随分区变化，它会在控制台常驻的前提下被整体重挂载，宿主持有的
                      会话命令指向已销毁实例，从通道/技能点「新建对话」即会失败。
                    */}
                    <div key={activeBot.id} className="_lh-claw-bot-panel">
                      {showBuddyOnboarding ? (
                        <div className="_lh-claw-bot-panel__cards min-w-0">
                          <AgentOnboardingPanel
                            key={activeBot.id}
                            botId={activeBot.id}
                            profileId={activeBot.profileId ?? ""}
                            onCreated={handleBuddyCreated}
                            execDebugCommand={repositories.bots.execDebugCommand}
                            initialName={activeBot.name}
                          />
                        </div>
                      ) : (
                      <Suspense
                        fallback={sectionFallback}
                      >
                        <div className="_lh-claw-bot-panel__cards min-w-0">
                          {activeSection === "channel" && (
                            <TeaSdkSettingsPanel
                              kind="channel"
                              instance={sdkInstance}
                              featureFlags={sdkFeatureFlags}
                              commandExecutor={teaSdkCommandExecutor}
                              useEnglish={useEnglish}
                              whatsAppOccupiedByOther={whatsAppOccupiedByOther}
                              channelAfterDescription={(
                                <>
                                  {weixinOccupiedByOther && activeBot.weixinOwner && (
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                      <span className="text-pretty">
                                        {t("微信已由 {{name}} 占用，同一实例只能连接一个 Bot。", {
                                          name: activeBot.weixinOwner.botName || t("其他 Bot"),
                                        })}
                                      </span>
                                      <button
                                        type="button"
                                        className="font-medium text-amber-950 underline underline-offset-2"
                                        onClick={() => handleSelectBot(activeBot.weixinOwner!.botId)}
                                      >
                                        {t("前往管理")}
                                      </button>
                                    </div>
                                  )}
                                  {whatsAppOccupiedByOther && activeBot.whatsAppOwner && (
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                      <span className="text-pretty">
                                        {t("WhatsApp 已由 {{name}} 连接。同一实例内，WhatsApp 同时只能连接一个 Bot。请先在原 Bot 断开连接。", {
                                          name: activeBot.whatsAppOwner.botName || t("其他 Bot"),
                                        })}
                                      </span>
                                      <button
                                        type="button"
                                        className="font-medium text-amber-950 underline underline-offset-2"
                                        onClick={() => handleSelectBot(activeBot.whatsAppOwner!.botId)}
                                      >
                                        {t("前往管理")}
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            />
                          )}
                          {activeSection === "connectors" && showConnectorsEntry && (
                            <AgentConnectorsPanel
                              instanceId={sdkInstance.InstanceId}
                              execCommand={activeBot ? (command, options) =>
                                repositories.bots.execDebugCommand(activeBot.id, command, options)
                              : undefined}
                            />
                          )}
                          {activeSection === "model" && (
                            <TeaSdkSettingsPanel
                              kind="model"
                              instance={sdkInstance}
                              featureFlags={sdkFeatureFlags}
                              commandExecutor={teaSdkCommandExecutor}
                              execDebugCommand={repositories.bots.execDebugCommand}
                              useEnglish={useEnglish}
                            />
                          )}
                          {activeSection === "skill" && (
                            <HermesAgentSkillsPanel
                              botId={activeBot.id}
                              profileId={activeBot.profileId}
                              execDebugCommand={repositories.bots.execDebugCommand}
                              initialSectionSlug={initialSectionSlug}
                            />
                          )}
                          {activeSection === "buddy" && (
                            <BuddyPanel botId={activeBot.id} profileId={activeBot.profileId} />
                          )}
                          {activeSection === "achievement" && (
                            <AchievementsPanel botId={activeBot.id} botName={activeBot.name} />
                          )}
                          {activeSection === "automations" && (
                            <HermesAgentAutomationsPanel
                              botId={{
                                instanceId: activeBot.instanceId ?? activeBot.id,
                                profileId: activeBot.profileId ?? "main",
                              }}
                              gatewayRunning={activeBot.gatewayRunning}
                              onRestartGateway={restartOrRepairDisabled ? undefined : () => setShowRestartConfirm(true)}
                            />
                          )}
                          {activeSection === "diagnostics" && (
                            <AgentDiagnosticsPanel
                              botId={activeBot.id}
                              profileId={activeBot.profileId}
                              botName={activeBot.name}
                              isMainBot={isActiveBotDefault}
                              execDebugCommand={repositories.bots.execDebugCommand}
                              execDebugCommandStream={repositories.bots.execDebugCommandStream}
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
                              maintenanceBusy={maintenanceBusy}
                              maintenanceScopeId={activeRuntimeInstanceId ?? activeBot.id}
                              onSessionRepairPendingChange={handleSessionRepairPendingChange}
                              workspaceRecoveryPanel={workspaceRecoveryPanel}
                            />
                          )}
                          {isActiveBotChatAvailable && (
                            <AgentChatMigrationSurface
                              active={activeSection === "chat" && presentationActive && !showMultiBotOnboarding}
                              preloadSessions={activeBot.status !== "paused" && sidebarTab === "daily" && chatSessionsExpanded && !isSidebarCollapsed}
                              agentPaused={activeBot.status === "paused" && activeBot.siblingsUnknown === "instance_stopped"}
                              accountId={accountId}
                              apiBase={resolveConfiguredAuthApiBaseUrl() || undefined}
                              enabled={openCraftChatEnabled}
                              instanceId={sdkInstance.InstanceId}
                              profileId={activeBot.profileId ?? (isActiveBotDefault ? "main" : "")}
                              region={isGlobal ? "intl" : "cn"}
                              locale={locale}
                              multiSession={openCraftChatMultiSessionBridge}
                              onSessionCommandsChange={setChatSessionCommands}
                              onHasMoreSessionsChange={setChatSessionsHasMore}
                              onPinSupportChange={setChatPinSupported}
                              onSessionMutationStateChange={setChatSessionMutationState}
                              onTurnCompleted={(chatId) => setUnread(chatId, true)}
                              legacy={null}
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
                          {activeSection === "settings" && (
                            <AgentCommonSettingsPanel
                              botId={activeBot.id}
                              profileId={activeBot.profileId}
                              botStatus={activeBot.status}
                              bots={repositories.bots}
                              getGatewayRestartCommand={async () => {
                                return (await getHermesScriptCommands(activeBot.profileId)).getGatewayRestartCommand();
                              }}
                            />
                          )}
                          {activeSection === "files" && (
                            <TatFileManagerPanel botId={activeBot.id} />
                          )}
                          {activeSection === "deepseek-harness" && (
                            <AgentDeepSeekHarnessPanel botId={activeBot.id} />
                          )}
                          {activeSection === "cloud-desktop" && cloudDesktopEnabled && (
                            <AgentCloudDesktopPanel botId={activeBot.id} />
                          )}
                          {activeSection === "website" && (
                            <AgentWebsitePanel />
                          )}
                          {activeSection === "browser" && (
                            <TatHermesWebPanel botId={activeBot.id} />
                          )}
                          {activeSection === "terminal" && (
                            <TerminalPanel botId={activeBot.id} botName={activeBot.name} />
                          )}
                        </div>
                      </Suspense>
                      )}
                    </div>
                  </section>
                </div>
                </Fragment>
              );
            })()
          )}

          {/*
            空状态：仅在不该走引导时出现（例如已有 bot 但都被过滤掉）。

            必须排除 showMultiBotOnboarding —— 首个 bot 引导中
            visibleBots 本来就是空的，两个条件同时成立会让引导表单下面
            再叠一个「新建 Bot」按钮（同一页面出现两套创建入口）。
          */}
          {
            !isModifying && !passesLoading && !isCreating && !botsLoading
              && !showMultiBotOnboarding && visibleBots.length === 0
              && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-sm" style={{ color: "rgba(0,0,0,0.40)" }}>{t("即刻创建你的云端智能体伙伴")}</p>
                {createLimitMessage && (
                  <p className="mt-3 max-w-sm text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.48)" }}>
                    {createLimitMessage}
                  </p>
                )}
                {directCreateError && (
                  <p className="mt-3 max-w-sm text-xs leading-relaxed text-red-500">
                    {directCreateError}
                  </p>
                )}
                <button
                  onClick={handleCreateNew}
                  disabled={!canCreateInitialAgent || directCreating}
                  className={cn(
                    "mt-6 inline-flex items-center gap-2 rounded-full px-6 py-2.5 font-semibold text-white transition-all",
                    canCreateInitialAgent && !directCreating
                      ? "bg-black/90 hover:opacity-90"
                      : "cursor-not-allowed bg-black/30",
                  )}
                  style={{ marginTop: 20, fontSize: 14, lineHeight: "20px" }}
                >
                  {directCreating && <Loader2 className="h-4 w-4 animate-spin" />}
                  {canCreateInitialAgent && !directCreating && <Plus className="h-4 w-4" aria-hidden="true" />}
                  {directCreating ? t("创建中...") : canCreateInitialAgent ? t("新建") : t("暂不可创建")}
                </button>
              </div>
            )
          }

        </section>
      </main>

    </div>
  );
};
