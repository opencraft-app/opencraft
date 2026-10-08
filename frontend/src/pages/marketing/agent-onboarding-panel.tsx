/**
 * 新用户创建个人助手引导（静态 Demo）
 * ──────────────────────────────────────────────────────────────
 * 新用户从首页 hero 进入 /agents 后的首屏：先完成「创建个人助手」，
 * 才解锁总览与其余功能入口。
 *
 * 两条创建路径，都会先播「喂咖啡」动效再进 dashboard：
 *   A. 自填表单：头像（形状/配色可换） + 名字 + 描述
 *   B. 个性化模板推荐：点卡片开详情弹窗，弹窗内「创建」
 *
 * 创建与配置使用真实接口；同标签页刷新通过按 Bot 隔离的快照续跑。
 *
 * 演示用法：
 *   - 进入引导态：/agents/overview?onboarding=1
 *   - 已创建态：点「创建」后自动进入
 */

import { ChevronLeft, ChevronRight, HelpCircle, RefreshCw } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import {
  AVATAR_SHAPES,
  getAvatarShapeLabel,
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  GeometricAvatar,
  randomizeAvatarBatch,
  type AvatarShapeId,
} from "@/pages/marketing/agent-avatar-shapes";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import {
  buildBuddySetupPlan,
  buildSandboxWarmupStep,
  SANDBOX_PROBE_INTERVAL_MS,
  SANDBOX_PROBE_TIMEOUT_MS,
  SANDBOX_READY_TIMEOUT_MS,
} from "@/pages/marketing/agent-buddy-setup";
import {
  buildHermesSoulContentReadCommand,
  parseHermesSoulContent,
} from "@/pages/marketing/agent-buddy-command";
import {
  classifySandboxProbeFailure,
  isSetupCommandSucceeded,
  runBuddySetupPlan,
  truncateSetupError,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import {
  buildSetupPlanSignature,
  clearBuddySetupSnapshot,
  collectCompletedKeys,
  loadBuddySetupSnapshot,
  saveBuddySetupSnapshot,
} from "@/pages/marketing/agent-buddy-setup-progress";
import {
  BUDDY_DESCRIPTION_PLACEHOLDER,
  BUDDY_NAME_DEFAULT,
  DEMO_TEMPLATES,
  type AgentTemplate,
} from "@/pages/marketing/agent-demo-templates";
import { TemplateDetailView } from "@/pages/marketing/agent-template-detail";

/** URL query：`?onboarding=1` 强制回到引导态，方便反复演示 */
const ONBOARDING_QUERY_KEY = "onboarding";


/**
 * 引导态开关。
 *
 * 真实的「是否已配置」由页面读 SOUL.md 判定；这里只负责两件事：
 *   - `?onboarding=1` 强制进入引导（演示 / 回归用）
 *   - 完成后清掉该 query，避免刷新又被拉回引导
 *
 * SSR 阶段没有 window，首帧返回 false 避免 hydration mismatch。
 */
export const useDemoOnboarding = () => {
  const [needsOnboardingByQuery, setNeedsOnboardingByQuery] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setNeedsOnboardingByQuery(
      new URLSearchParams(window.location.search).get(ONBOARDING_QUERY_KEY) === "1",
    );
  }, []);

  const completeOnboarding = useCallback(() => {
    if (typeof window !== "undefined") {
      /* 清掉 ?onboarding=1，否则刷新会被强制拉回引导态。
         用 replaceState 而非 navigate：不新增历史记录，避免「返回」又回到引导。 */
      const url = new URL(window.location.href);
      if (url.searchParams.has(ONBOARDING_QUERY_KEY)) {
        url.searchParams.delete(ONBOARDING_QUERY_KEY);
        window.history.replaceState({}, "", url.toString());
      }
    }
    setNeedsOnboardingByQuery(false);
  }, []);

  return { needsOnboardingByQuery, completeOnboarding };
};

/* ─────────────────────────── 模板详情弹窗 ─────────────────────────── */

const TemplateDialog = ({
  template,
  onClose,
  onCreate,
}: {
  template: AgentTemplate;
  onClose: () => void;
  onCreate: () => void;
}) => {
  const t = useT();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* 固定高度：无论模板内容多少，弹窗尺寸一致，切模板时不跳动。
          max-h 兜底小屏，避免固定高度撑出视口。 */}
      <DialogContent className="flex h-[34rem] max-h-[calc(100vh-4rem)] flex-col bg-white rounded-[0.875rem] md:w-[44rem]">
        <TemplateDetailView template={template} actionLabel={t("创建")} onAction={onCreate} />
      </DialogContent>
    </Dialog>
  );
};

/* ──────────────────────── 个性化模板推荐（横向） ──────────────────────── */

const TemplateRecommendations = ({
  templates,
  onPick,
}: {
  templates: AgentTemplate[];
  onPick: (template: AgentTemplate) => void;
}) => {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  const syncScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanScrollPrev(el.scrollLeft > 1);
    setCanScrollNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    syncScrollState();
    window.addEventListener("resize", syncScrollState);
    return () => window.removeEventListener("resize", syncScrollState);
  }, [syncScrollState, templates]);

  /* 一屏恰好放满一批卡片（桌面 3 张 / 窄屏 2 张），翻一批 = 视口宽 + 一个 gap-3（12px） */
  const scrollByPage = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * (el.clientWidth + 12), behavior: reduceMotion ? "auto" : "smooth" });
  };

  const arrowClass =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-black/60 transition-colors hover:bg-black/[0.03] hover:text-black disabled:cursor-default disabled:border-black/[0.06] disabled:bg-transparent disabled:text-black/20";

  return (
    <section className="mt-7">
      <h3 className="mb-3 text-[13px] font-medium text-black/45">{t("建议")}</h3>

      {/* 左按钮 / 内容视口 / 右按钮（DESIGN.md · Carousel Navigation）。
          视口保留原生横向滚动 + snap，触控板/触屏仍可直接滑动。 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => scrollByPage(-1)}
          disabled={!canScrollPrev}
          aria-label={t("上一批")}
          title={t("上一批")}
          className={arrowClass}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <div
          ref={scrollerRef}
          onScroll={syncScrollState}
          className="flex min-w-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onPick(template)}
              className="flex w-[calc((100%-12px)/2)] shrink-0 snap-start items-start gap-3 rounded-[10px] sm:w-[calc((100%-24px)/3)] border border-black/[0.06] bg-white p-3 text-left transition hover:border-black/[0.12] hover:bg-black/[0.015]"
            >
              <GeometricAvatar
                shapeId={template.shapeId}
                color={template.color}
                size={40}
                className="shrink-0"
              />
              {/* Demo 常量中文无法被 i18n-extract 静态提取，接真实接口时由后端返回已本地化文案 */}
              <span className="min-w-0">
                <span className="block text-sm font-medium text-black/[0.88]">{template.name}</span>
                <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-black/45">
                  {template.description}
                </span>
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => scrollByPage(1)}
          disabled={!canScrollNext}
          aria-label={t("下一批")}
          title={t("下一批")}
          className={arrowClass}
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
};

/* ──────────────────────────────── 引导面板 ──────────────────────────────── */

/*
 * 沙箱预热的超时 / 间隔常量已移到 agent-buddy-setup.ts，与
 * buildSandboxWarmupStep 放在一起 —— 那个步骤的 timeoutMs 就取自
 * SANDBOX_READY_TIMEOUT_MS，两者必须同源，分开放很容易改一个忘一个。
 */

/** 等 botId 的轮询间隔：路由导航很快，探密一点即可 */
const BOT_ID_PROBE_INTERVAL_MS = 200;

/** 读 SOUL 原文的超时，与总览页编辑资料保持一致 */
const SOUL_READ_TIMEOUT_MS = 30_000;

/**
 * 「空白创建」在下拉里的哨兵值。
 *
 * 对外（cloneOptions.value / sourceBotId）空白创建一律用空串表示，但
 * Radix Select 不允许 item 的 value 为空串（它把空串当成「未选中」），
 * 所以界面层用这个哨兵值顶一下，读写时两边转换。
 */
const BLANK_CREATE_VALUE = "__blank__";

export const AgentOnboardingPanel = ({
  botId,
  /*
   * 不给默认值 "main" —— 那是主 bot 的 profile，猜错会把新 bot 的人设
   * 写进主 bot。拿不到时由 waitForProfileId 等，等不到就报错。
   */
  profileId = "",
  onCreated,
  onCreateBot,
  execDebugCommand,
  initialName,
  cloneOptions,
  onSetupStart,
}: {
  /**
   * 目标 bot。订阅开通 instance 时后端已自带一个 default bot，
   * 所以这里是「对既有 bot 写配置」，而不是再新建一个。
   */
  botId: string;
  profileId?: string;
  /**
   * 配置完成后回调。
   *
   * 带上实际写入配置的那个 bot 的 id —— 多 bot 路径下它是本页刚建出来的，
   * 页面侧要靠它切到新 bot；不带的话页面只能沿用当前 activeBot，用户创建完
   * 会停在原来那个 bot 的页面上。
   */
  onCreated: (createdBotId: string) => void;
  /** 沙箱命令执行器（由页面注入 repositories.bots.execDebugCommand） */
  execDebugCommand: SetupExec;
  /**
   * 名字初值。多 bot 创建时传入弹窗里填的 bot 名，避免用户重复输入；
   * 不传则用默认名。
   */
  initialName?: string;
  /**
   * 用户点「创建」、面板进入配置阶段时触发（只报一次，早于任何沙箱操作）。
   *
   * 页面侧需要它把「引导正在进行」这件事记下来：订阅路径下实例是后端随订阅
   * 建好的，页面那个「实例已就绪就退出 loading」的兜底 effect 会把 isCreating
   * 置 false，进而卸载本面板 —— 用户点完模板瞬间被弹回表单，配置一步都没跑。
   */
  onSetupStart?: () => void;
  /**
   * 创建 bot 本身（多 bot 入口用）。
   *
   * 传入时表示「实例还不存在」：用户在本页填完资料点创建，先用这个回调
   * 建实例、拿到 botId 与 profileId，再继续写人设与配置。
   * 订阅路径不传 —— 那条路实例已经由 ?creating= 带进来了。
   *
   * 返回 null 表示创建失败，面板会退回表单并提示。
   */
  onCreateBot?: (params: {
    name: string;
    /** 复制来源 bot 的 id */
    sourceBotId: string;
  }) => Promise<{ botId: string; profileId: string } | null>;
  /**
   * 「从其他 Bot 复制」的候选（仅已有 bot 时传入）。
   *
   * 列出账号下**全部** bot，而不是只给「复制当前 / 复制主 Bot」两个模式 ——
   * 用户在 A bot 页面下想复制 B bot 是很自然的需求，按模式给会漏掉 B。
   * 首个 bot（订阅后）不传，因为没有可复制的来源。
   */
  cloneOptions?: {
    /**
     * 当前选中的来源 bot id。
     *
     * 空串 = 空白创建（不复制任何 bot），也是默认值。
     * 用空串而不是额外加一个 mode 字段，是因为下游 addBot 正好按
     * 「有没有 sourceBotId」来决定 createMode，语义是对齐的。
     */
    value: string;
    onChange: (next: string) => void;
    /** 账号下全部可复制的 bot（不含「空白创建」那一项，由面板自己加） */
    choices: {
      id: string;
      label: string;
      /** 主 bot 标记，列表里给个角标 */
      isDefault?: boolean;
    }[];
  };
}) => {
  const t = useT();

  /** form：填表阶段；creating：写配置阶段 */
  const [phase, setPhase] = useState<"form" | "creating">("form");
  /** 待执行的配置（进入 creating 阶段时定下，避免后续表单改动影响执行） */
  const [pendingSetup, setPendingSetup] = useState<{
    profile: { name: string; description: string };
    template?: AgentTemplate;
    avatar: { shapeId: string; color: string };
    preserveSoul?: boolean;
    resume?: boolean;
  } | null>(null);
  /** 配置计划的步骤进度（不含预热，预热见 warmupState） */
  const [steps, setSteps] = useState<SetupStepState[]>([]);
  /**
   * 预热步骤的状态，与 steps 分开存。
   *
   * 不能塞进 steps：runBuddySetupPlan 的 onProgress 回传的是**全量**快照，
   * setSteps(states) 会整体替换，混在一起的预热状态会被当场冲掉。分开存、
   * 渲染时再拼成一份清单，两边互不干扰。
   */
  const [warmupState, setWarmupState] = useState<SetupStepState | null>(null);
  /** 阻断性错误（沙箱超时 / SOUL 写入失败） */
  const [fatalError, setFatalError] = useState<string | null>(null);
  /** 非阻断失败数，仅用于完成后提示 */
  const [partialFailureCount, setPartialFailureCount] = useState(0);
  /** 部分失败时停在清单页，记下要跳转的 bot，等用户点「进入 Bot」 */
  const [createdBotId, setCreatedBotId] = useState("");

  /**
   * 轮询探测沙箱是否已能执行命令。
   *
   * bot.status === "active" 不代表沙箱容器已起好，直接写配置会失败，
   * 所以用一条无副作用的 `true` 命令探活。
   */
  /*
   * botId 可能晚于面板渲染才到位（见上方 waitForBotId 的调用处说明）。
   * 用 ref 持有最新值，避免轮询闭包里读到渲染时的空字符串。
   */
  const botIdRef = useRef(botId);
  botIdRef.current = botId;

  /*
   * profileId 同理，且更要紧：写错 profile 会把新 bot 的人设写进别的 bot。
   * 所以调用方在拿不到时传空串，这里等它到位，绝不默认成 "main"。
   */
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  /** 等 botId 出现，最多等 SANDBOX_READY_TIMEOUT_MS */
  const waitForBotId = useCallback(
    async (isCancelled: () => boolean): Promise<string> => {
      if (botIdRef.current) return botIdRef.current;
      const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (isCancelled()) return "";
        await new Promise((resolve) => window.setTimeout(resolve, BOT_ID_PROBE_INTERVAL_MS));
        if (botIdRef.current) return botIdRef.current;
      }
      return "";
    },
    [],
  );

  /**
   * 等 profileId 出现。
   *
   * 与 waitForBotId 同构，但语义更严：拿不到就返回空串让调用方报错，
   * 而不是退回 "main"（那会写进主 bot）。
   */
  const waitForProfileId = useCallback(
    async (isCancelled: () => boolean): Promise<string> => {
      if (profileIdRef.current) return profileIdRef.current;
      const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (isCancelled()) return "";
        await new Promise((resolve) => window.setTimeout(resolve, BOT_ID_PROBE_INTERVAL_MS));
        if (profileIdRef.current) return profileIdRef.current;
      }
      return "";
    },
    [],
  );

  /**
   * 轮询探测沙箱是否已能执行命令。
   *
   * bot.status === "active" 不代表沙箱容器已起好，直接写配置会失败，
   * 所以用一条无副作用的 `true` 命令探活。
   *
   * 返回 `{ ready: false, reason }`（而不是裸 false）：调用方要把真实原因
   * 显示出来。原先这里 `catch {}` 吞掉一切异常、只返回 true/false，导致
   * 401/403/404 这类永不自愈的错误也被当成「还没起好」空转满超时，最后统一
   * 报「实例尚未就绪」—— 用户和排障的人都拿不到任何线索。
   *
   * `fatal` 为真表示已判定为永久失败、提前跳出了轮询，没有等满超时。
   */
  const waitForSandbox = useCallback(
    async (
      targetBotId: string,
      isCancelled: () => boolean,
    ): Promise<{ ready: boolean; reason?: string; fatal?: boolean }> => {
      const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
      /** 最后一次探活为什么没成功，超时兜底时带给用户 */
      let lastReason = "";
      while (Date.now() < deadline) {
        if (isCancelled()) return { ready: false };
        try {
          const result = await execDebugCommand(targetBotId, "true", {
            timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
          });
          if (result.exitCode === 0) return { ready: true };
          // 命令跑了但没成功：沙箱可能还在初始化，记下原因继续等
          lastReason = truncateSetupError(result.output, result.status || `exit ${result.exitCode}`, 160);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastReason = message;
          /*
           * 永久性失败立刻中止。
           *
           * 鉴权失效、无权限、实例已被回收都属于「再等三分钟也是同样的
           * 响应」，继续轮询只是让用户白等，还会把真实原因埋掉。
           */
          if (classifySandboxProbeFailure(error) === "fatal") {
            return { ready: false, reason: message, fatal: true };
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, SANDBOX_PROBE_INTERVAL_MS));
      }
      return { ready: false, reason: lastReason };
    },
    [execDebugCommand],
  );

  /*
   * 执行期回调与入参统一放进 ref。
   *
   * 这不是风格偏好，是为了让下面那个「建 bot + 写配置」的 effect 只在
   * phase / pendingSetup 变化时跑。onCreated 之类的 prop 引用很容易每次
   * 渲染都变（页面侧的回调依赖链上只要有一个未 memo 的对象就会如此），
   * 一旦它们留在依赖数组里，effect 就会每渲染一次 cleanup + 重跑 ——
   * 而重跑会再调一次 onCreateBot（又建一个 bot），并把上一次写配置的
   * 流程 cancel 掉。表现就是：bot 越建越多、人设与技能一个都没写进去、
   * 配额耗尽后弹回创建表单。
   */
  const runtimeRef = useRef({
    onCreateBot,
    onCreated,
    onSetupStart,
    cloneValue: cloneOptions?.value,
  });
  runtimeRef.current = { onCreateBot, onCreated, onSetupStart, cloneValue: cloneOptions?.value };

  /**
   * 本次创建已经建好的实例。
   *
   * 即便 effect 因为将来某个改动又开始重跑，同一份 pendingSetup 也只会
   * 建一次 bot —— 重跑时直接复用这里缓存的 id，而不是再建一个。
   */
  const createdRef = useRef<{
    token: object;
    botId: string;
    profileId: string;
  } | null>(null);

  /**
   * 已启动配置流程的 pendingSetup。
   *
   * 重入守卫：effect 只要发现当前这份待办已经在跑就直接返回，
   * 保证「一次创建 = 一个 bot = 一次配置」。
   */
  const setupTokenRef = useRef<object | null>(null);

  /**
   * 组件是否已卸载。
   *
   * 配置流程的中止只看这个 —— 用户离开页面就不再往沙箱写东西；
   * 而 effect 因依赖抖动重跑时，不该影响正在进行的流程。
   */
  const unmountedRef = useRef(false);
  useEffect(() => {
    /*
     * setup 里必须显式复位。
     *
     * next.config.mjs 开了 reactStrictMode，React 会在同一个组件实例上把
     * effect 重放一遍：setup → cleanup → setup。只在 cleanup 里置 true 的话，
     * 重放结束后这个标记就永久是 true，于是后续 run() 在第一个 cancelled()
     * 检查处直接静默返回 —— 表现为咖啡杯卡在 0/2、不报错、不推进。
     */
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Only a mounted, identified Bot may resume. The empty-ID create form must never
  // consume another Bot's snapshot or issue a second creation request.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || pendingSetup || !botId || !profileId) return;
    const snapshot = loadBuddySetupSnapshot(botId);
    if (!snapshot || (snapshot.profileId && snapshot.profileId !== profileId)) return;
    const template = snapshot.templateId
      ? DEMO_TEMPLATES.find((item) => item.id === snapshot.templateId)
      : undefined;
    if (snapshot.templateId && !template) {
      clearBuddySetupSnapshot(botId);
      return;
    }
    restoredRef.current = true;
    runtimeRef.current.onSetupStart?.();
    setPendingSetup({
      profile: snapshot.profile,
      template,
      avatar: snapshot.avatar,
      preserveSoul: snapshot.preserveSoul,
      resume: true,
    });
    setWarmupState({ step: buildSandboxWarmupStep(t), status: "running" });
    setPhase("creating");
  }, [botId, profileId, pendingSetup, t]);

  const protectUnload = phase === "creating" && !fatalError && !createdBotId
    && Boolean(pendingSetup);
  useEffect(() => {
    if (!protectUnload) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [protectUnload]);

  /* ── 头像 ── */
  const [shapeId, setShapeId] = useState<AvatarShapeId>(DEFAULT_AVATAR_SHAPE);
  const [color, setColor] = useState(DEFAULT_AVATAR_COLOR);
  /** 当前展示的候选形状（「换一批」会重新抽） */
  const [shapeBatch, setShapeBatch] = useState(() => AVATAR_SHAPES.slice(0, 8));

  /* ── 表单 ── */
  /*
   * 名字默认值：优先用创建时填的 bot 名。
   *
   * 多 bot 创建时用户已在弹窗里填过一次名字（那是 profile 目录名，必须在
   * addBot 之前定下，hermes 用它做 spawn 与 profile 解析）。这里预填同一个值，
   * 用户确认或改掉即可 —— 改动只影响 display_name，不动目录名。
   * 不预填的话用户会觉得"刚填的名字怎么没了"。
   */
  /*
   * 默认名走 t()：BUDDY_NAME_DEFAULT 是中文常量，直接用会让国际站表单里
   * 冒出「我的 AI 伙伴」。用惰性初始化，t 在首次渲染时已可用。
   */
  const [name, setName] = useState(() => initialName?.trim() || t(BUDDY_NAME_DEFAULT));
  const [description, setDescription] = useState("");
  /** 高级选项默认折叠：复制来源是少数场景，不该挤占主路径 */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /* ── 模板弹窗 ── */
  const [activeTemplate, setActiveTemplate] = useState<AgentTemplate | null>(null);

  const canSubmit = name.trim().length > 0;

  /** 空白创建：没有选中任何来源 bot（空串） */
  const isBlankCreate = !cloneOptions?.value;

  /** 换一批：重抽候选形状 + 换个配色；若当前形状不在新批次里则顺延选中第一个 */
  const handleRandomize = () => {
    const next = randomizeAvatarBatch({ currentColor: color });
    setShapeBatch(next.shapes);
    setColor(next.color);
    if (!next.shapes.some((item) => item.id === shapeId)) {
      setShapeId(next.shapes[0]!.id);
    }
  };

  /**
   * 两条创建路径共用：落资料 → 建 bot → 跑配置计划。
   * 传入 template 表示走「模板创建」（附带技能 / 定时任务 / 用户画像）；
   * 不传则走「自填表单」，只写人设。
   */
  const handleCreate = useCallback(
    (template?: AgentTemplate) => {
      /*
       * 先通知页面「引导已进入配置阶段」，再做任何状态变更。
       *
       * 必须在最前面：页面要靠这个信号挡住那个会卸载本面板的兜底 effect
       * （订阅路径下实例本来就是 running，effect 一跑就把 isCreating 置 false）。
       */
      runtimeRef.current.onSetupStart?.();

      const nextProfile = {
        name: (template ? template.name : name.trim()) || t(BUDDY_NAME_DEFAULT),
        description: template ? template.description : description.trim(),
      };
      const nextAvatar = {
        shapeId: template ? template.shapeId : shapeId,
        color: template ? template.color : color,
      };
      setActiveTemplate(null);
      setPendingSetup({
        profile: nextProfile,
        template,
        avatar: nextAvatar,
        preserveSoul: !template && Boolean(runtimeRef.current.cloneValue),
      });

      /*
       * 进 creating 的同一帧就把步骤清单铺出来（全为 pending）。
       *
       * 计划本身不依赖 botId / profileId，能提前算；而真正执行前要先建实例、
       * 再等沙箱就绪，这段是整个流程最慢的一截。原先把 setSteps 放在那之后，
       * 用户在最需要反馈的几分钟里只看到一只咖啡杯，完全不知道要装技能、
       * 装到哪一步了 —— 选了模板却看不到「安装技能」就是这么来的。
       *
       * 这里传占位 profileId：清单只用到 step.label，真正执行时会用拿到的
       * profileId 重算一次计划，不会拿占位值去写沙箱。
       */
      setSteps(
        buildBuddySetupPlan({
          profile: nextProfile,
          template,
          profileId: "main",
          avatar: nextAvatar,
          timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
          // 传 t：步骤 label 要跟界面同语言，否则英文表单点完会跳出中文清单
          t,
        }).map((step) => ({ step, status: "pending" as const })),
      );
      /*
       * 预热直接进 running，而不是先 pending。
       *
       * 「确保实例存在 + 等它能执行命令」这一整段本来就是从这一刻开始的，
       * 清单上必须立刻有一行在转 —— 否则用户看到的还是全灰的 0/N，跟原来
       * 那个「卡在喂咖啡」的表象一模一样。
       */
      setWarmupState({ step: buildSandboxWarmupStep(t), status: "running" });
      setPhase("creating");
    },
    [name, shapeId, color, description],
  );

  /*
   * 真实配置流程：建实例 → 等沙箱可用 → 按计划写配置。
   *
   * 这个 effect 带不可逆副作用（建 bot、往沙箱写东西），所以它被设计成
   * 「每份 pendingSetup 只允许跑一次」：
   *
   *   - setupTokenRef 做重入守卫。哪怕依赖数组因为某个 prop 引用变化而
   *     重新触发，也会在这里直接返回，不会再建一个 bot。
   *   - 中止只绑定「组件卸载」（unmountedRef），不绑定 effect 重跑。
   *     早先的写法在 cleanup 里无条件 cancelled = true，于是依赖一抖动就把
   *     正在进行的写配置中断掉 —— 人设与技能写不进去就是这么来的。
   */
  useEffect(() => {
    if (phase !== "creating" || !pendingSetup) return;
    // 同一份待办已经在跑：直接返回，绝不重复建实例
    if (setupTokenRef.current === pendingSetup) return;
    setupTokenRef.current = pendingSetup;

    /* 只有真正卸载才算取消；effect 重跑不该影响进行中的流程 */
    const cancelled = () => unmountedRef.current;

    const run = async () => {
      let targetBotId = "";
      try {
        /*
         * 0. 先确保实例存在。
         *
         * 两条来源：
         *   a) 多 bot 入口 —— 实例还没建，用 onCreateBot 现场创建。
         *      必须在这里建而不是更早，因为「复制哪个 bot」是用户在本页选的。
         *   b) 订阅路径 —— 实例已由 ?creating=<botId> 带进来，等它到位即可。
         *      引导会早于 URL 更新就渲染（否则中间那帧会漏回咖啡杯），
         *      填表通常远慢于路由，但手速极快时仍可能为空，所以等而不是直接失败。
         */
        let targetProfileId = "";

        const cached = createdRef.current?.token === pendingSetup ? createdRef.current : null;
        if (cached) {
          targetBotId = cached.botId;
          targetProfileId = cached.profileId;
        } else if (runtimeRef.current.onCreateBot && !restoredRef.current) {
          const created = await runtimeRef.current.onCreateBot({
            name: pendingSetup.profile.name,
            sourceBotId: runtimeRef.current.cloneValue ?? "",
          });
          if (cancelled()) return;
          if (!created) {
            // 页面已显示创建失败原因，退回表单允许用户修改参数。
            setPhase("form");
            setPendingSetup(null);
            setSteps([]);
            setWarmupState(null);
            setupTokenRef.current = null;
            return;
          }
          targetBotId = created.botId;
          targetProfileId = created.profileId;
        } else {
          targetBotId = await waitForBotId(cancelled);
          if (cancelled()) return;
          if (!targetBotId) {
            throw new Error(t("等不到 Bot 实例，请返回列表后重新进入配置"));
          }
        }

        createdRef.current = { token: pendingSetup, botId: targetBotId, profileId: targetProfileId };
        const previous = loadBuddySetupSnapshot(targetBotId);
        saveBuddySetupSnapshot({
          botId: targetBotId,
          profileId: targetProfileId || profileIdRef.current,
          profile: pendingSetup.profile,
          avatar: pendingSetup.avatar,
          templateId: pendingSetup.template?.id ?? "",
          preserveSoul: Boolean(pendingSetup.preserveSoul),
          planSignature: pendingSetup.resume ? previous?.planSignature ?? "" : "",
          completedKeys: pendingSetup.resume ? previous?.completedKeys ?? [] : [],
        });

        // 1. 等实例真正可执行命令 —— status 变 active 不等于沙箱就绪
        const probe = await waitForSandbox(targetBotId, cancelled);
        if (cancelled()) return;
        if (!probe.ready) {
          /*
           * 把真实原因带出去，分两种口径：
           *   - fatal：已明确判定为永久失败（401/403/404 等），没有等满超时，
           *     所以不能说「稍后重试」—— 直接把服务端给的原因摆出来。
           *   - 超时：确实等满了，沿用原文案，但补上最后一次探测的失败原因，
           *     让用户和客服至少知道是网络、鉴权还是实例侧的问题。
           */
          setWarmupState((prev) => (prev
            ? { ...prev, status: "failed", error: probe.reason }
            : prev));
          if (probe.fatal && probe.reason) {
            throw new Error(probe.reason);
          }
          throw new Error(probe.reason
            ? t("实例尚未就绪，请稍后在设置页重试配置（最后一次探测：{{reason}}）", {
              reason: probe.reason,
            })
            : t("实例尚未就绪，请稍后在设置页重试配置"));
        }
        // 实例已可执行命令：预热这一行落成，进度从此开始往前走
        setWarmupState((prev) => (prev ? { ...prev, status: "done", error: undefined } : prev));

        // 2. 按计划写 SOUL / 用户画像 / 技能 / 定时任务
        //    profileId 决定写进哪个 bot，拿不到就停 —— 猜错会串写到别的 bot。
        //    onCreateBot 路径下它已随新实例一起返回，无需再等。
        if (!targetProfileId) {
          targetProfileId = await waitForProfileId(cancelled);
          if (cancelled()) return;
        }
        if (!targetProfileId) {
          throw new Error(t("等不到 Bot 的人设档案，请返回列表后重新进入配置"));
        }
        createdRef.current = { token: pendingSetup, botId: targetBotId, profileId: targetProfileId };

        /*
         * 克隆来的 bot 且没选模板时，保留继承来的人设正文，只改名字与简介。
         *
         * 克隆会把来源 bot 的 SOUL 一起带过来。若这里再生成一份通用 SOUL
         * 覆盖上去，等于把刚复制来的人设当场抹掉 —— 用户只填了个名字，
         * 却丢了来源 bot 调教好的人设。
         *
         * 两种情况不需要保留：
         *   - 空白创建：本来就没有可继承的人设，读了也是空，白等一次命令；
         *   - 选了模板：模板的全部意义就是给一套新人设，该覆盖。
         */
        const shouldPreserveSoul = !pendingSetup.template && pendingSetup.preserveSoul;
        let existingSoul = "";
        if (shouldPreserveSoul) {
          try {
            const read = await execDebugCommand(
              targetBotId,
              buildHermesSoulContentReadCommand(targetProfileId),
              { timeoutMs: SOUL_READ_TIMEOUT_MS },
            );
            const parsed = parseHermesSoulContent(read.output || "");
            if (!isSetupCommandSucceeded(read) || parsed.status !== "ready" || !parsed.markdown.trim()) {
              throw new Error(t("无法读取人设文件，请重试"));
            }
            existingSoul = parsed.markdown;
          } catch {
            // 克隆读取失败时停止，不能用新生成的人设覆盖继承内容。
            throw new Error(t("无法读取人设文件，请重试"));
          }
          if (cancelled()) return;
        }

        const plan = buildBuddySetupPlan({
          profile: pendingSetup.profile,
          template: pendingSetup.template,
          profileId: targetProfileId,
          avatar: pendingSetup.avatar,
          timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
          // 克隆路径只有完整读取成功才会到达这里。
          preserveSoulContent: Boolean(existingSoul),
          existingSoul,
          t,
        });

        const snapshot = loadBuddySetupSnapshot(targetBotId);
        const resumeKeys = pendingSetup.resume
          && snapshot?.profileId === targetProfileId
          && snapshot.planSignature === buildSetupPlanSignature(plan)
          ? new Set(snapshot.completedKeys)
          : undefined;

        /* 每完成一步就落盘，刷新后据此续跑 */
        const persist = (states: SetupStepState[]) => {
          saveBuddySetupSnapshot({
            botId: targetBotId,
            profileId: targetProfileId,
            profile: pendingSetup.profile,
            avatar: pendingSetup.avatar,
            templateId: pendingSetup.template?.id ?? "",
            preserveSoul: Boolean(pendingSetup.preserveSoul),
            planSignature: buildSetupPlanSignature(plan),
            completedKeys: collectCompletedKeys(states),
          });
        };
        /*
         * 清单已在进入 creating 时铺好，这里只在步骤数不一致时才重置 ——
         * 同样的入参算出的计划结构是一样的，无条件 setSteps 会让已渲染的
         * 清单闪一下。数量不同说明计划确实变了（理论上不该发生），以真实
         * 计划为准。
         */
        setSteps((prev) => (
          prev.length === plan.length
            ? prev
            : plan.map((step) => ({ step, status: "pending" as const }))
        ));

        const result = await runBuddySetupPlan({
          botId: targetBotId,
          steps: plan,
          exec: execDebugCommand,
          onProgress: (states) => {
            // A response from an old mount must not overwrite a newer recovery.
            // In-flight cron operations are reconciled by the sandbox lock.
            if (cancelled()) return;
            persist(states);
            setSteps(states);
          },
          shouldCancel: cancelled,
          completedKeys: resumeKeys ?? undefined,
        });
        if (cancelled()) return;

        /*
         * 跑完就清快照 —— 不论是否有步骤失败。
         *
         * 走到这里说明每一步都已尝试过、结果也呈现给用户了（失败项在清单上
         * 标红）。留着快照只会让下次进页面又弹一次续跑，而该补的东西用户
         * 已经被引导去技能页/定时任务页手动处理了。
         *
         * 真正需要保留快照的是「中途被打断」—— 那种情况根本执行不到这里。
         */
        clearBuddySetupSnapshot(targetBotId);

        /*
         * 有非阻断步骤失败时，停在清单页让用户看清哪几步红了。
         *
         * 原先是「设一下提示就立刻 onCreated()」，可 onCreated 会切页面 ——
         * 提示所在的界面当场被卸载，那行字一帧都没显示出来。结果用户看到
         * 的是「创建成功」，进去却发现技能没装、定时任务是空的，完全不知道
         * 中间失败过。技能安装依赖沙箱里的 curl/tar/acli，失败并不罕见，
         * 这个反馈必须让人看见。
         *
         * 清单本身已经逐步标了失败标记与原因，用户可以据此决定去技能页还是
         * 定时任务页补，点「完成」再走。
         */
        if (result.failures.length > 0) {
          setPartialFailureCount(result.failures.length);
          setCreatedBotId(targetBotId);
          return;
        }
        setCreatedBotId(targetBotId);
        runtimeRef.current.onCreated(targetBotId);
      } catch (error) {
        if (cancelled()) return;
        // 保留目标与进度：重试或刷新继续配置同一个 Bot。
        setFatalError(error instanceof Error ? error.message : String(error));
      }
    };

    void run();
    /*
     * 依赖刻意只留 phase / pendingSetup 与稳定的工具函数。
     *
     * onCreateBot、onCreated、cloneOptions.value 走 runtimeRef 读最新值，
     * 不进依赖数组 —— 它们的引用会随父组件渲染而变，留在这里会让整个创建
     * 流程被反复 cancel 并重复建 bot。改依赖前先想清楚：这个 effect 带副
     * 作用（建实例、写沙箱），重跑不是幂等的。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pendingSetup, waitForBotId, waitForProfileId, waitForSandbox, execDebugCommand, t]);

  /** 卡片上不重复展示当前选中的模板 */
  const templates = useMemo(() => DEMO_TEMPLATES, []);

  /*
   * 渲染用的完整清单：预热行 + 配置计划。
   *
   * 合并只发生在渲染层，两份状态各自独立更新 —— runner 的 onProgress 回传
   * 全量快照，混存会把预热状态冲掉（见 warmupState 的声明处）。
   */
  const visibleSteps = useMemo(
    () => (warmupState ? [warmupState, ...steps] : steps),
    [warmupState, steps],
  );

  if (phase === "creating") {
    return (
      <CreatingLoadingView
        errorMessage={fatalError}
        onRetry={fatalError && pendingSetup ? () => {
          const next = { ...pendingSetup, resume: true };
          if (createdRef.current?.token === pendingSetup) {
            createdRef.current = { ...createdRef.current, token: next };
          }
          setFatalError(null);
          /*
           * 预热必须重新探。它是一次实时探测，不是幂等的配置写入 ——
           * 沿用上一轮的 failed/done 会让用户以为没重试，或者更糟：
           * 顶着一个未就绪的实例直接往下写配置。
           */
          setWarmupState({ step: buildSandboxWarmupStep(t), status: "running" });
          setPendingSetup(next);
        } : undefined}
        steps={visibleSteps}
        partialFailureCount={partialFailureCount}
        onContinue={createdBotId
          ? () => runtimeRef.current.onCreated(createdBotId)
          : undefined}
      />
    );
  }

  return (
    <div className="mx-auto flex min-w-0 max-w-[720px] flex-col py-6">
      {partialFailureCount > 0 ? (
        <p className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          {t("有 {{count}} 项配置未完成，可在技能 / 定时任务页面重试", { count: partialFailureCount })}
        </p>
      ) : null}
      <div className="flex flex-col items-center text-center">
        {/* ── 头像预览：选中的大头像持续呼吸 + 偶尔眨眼 ── */}
        <GeometricAvatar shapeId={shapeId} color={color} size={84} alive />

        {/* ── 形状选择：固定一行，不换行 ── */}
        <div className="mt-4 flex flex-nowrap justify-center gap-2">
          {shapeBatch.map((shape) => (
            <button
              key={shape.id}
              type="button"
              aria-label={getAvatarShapeLabel(shape.id, t)}
              aria-pressed={shape.id === shapeId}
              onClick={() => setShapeId(shape.id)}
              className={cn(
                // 无边框：几何体本身有形状与配色，方框反而抢视线
                "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px] transition",
                shape.id === shapeId
                  ? "bg-black/[0.06]"
                  : "hover:bg-black/[0.03]",
              )}
            >
              <GeometricAvatar shapeId={shape.id} color={color} size={26} alive={shape.id === shapeId} />
            </button>
          ))}
        </div>

        {/* ── 换一批：同时换形状候选与配色 ── */}
        <button
          type="button"
          onClick={handleRandomize}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[13px] font-medium text-black/55 transition hover:bg-black/[0.03] hover:text-black/80"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("换一批")}
        </button>

        {/* ── 表单 ── */}
        <div className="mt-5 w-full max-w-[420px]">
          <label
            className="block text-left text-[11px] font-medium text-black/40"
            htmlFor="lv-onboarding-name"
          >
            {t("名字")}
          </label>
          <input
            id="lv-onboarding-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-black/[0.1] px-3 py-2 text-sm font-medium text-black/[0.88] outline-none transition focus:border-black/25"
          />
        </div>

        <div className="mt-3 w-full max-w-[420px]">
          <label
            className="block text-left text-[11px] font-medium text-black/40"
            htmlFor="lv-onboarding-desc"
          >
            {t("描述")}
            <span className="ml-1 text-black/30">{t("（可选）")}</span>
          </label>
          <textarea
            id="lv-onboarding-desc"
            value={description}
            rows={2}
            placeholder={t(BUDDY_DESCRIPTION_PLACEHOLDER)}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-1 w-full resize-none rounded-md border border-black/[0.1] px-3 py-2 text-[13px] leading-5 text-black/70 outline-none transition placeholder:text-black/30 focus:border-black/25"
          />
        </div>

        {/*
          高级选项（仅已有 bot 时传入）。
          默认折叠 —— 新建 bot 的主路径是「起个名字就走」，复制来源属于少数
          场景。新订阅用户不传 cloneOptions，因为没有可复制的来源。
        */}
        {cloneOptions ? (
          <div className="mt-3 w-full max-w-[420px]">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
              className="inline-flex items-center gap-1 rounded-[3px] py-1 text-[12px] font-medium text-black/45 transition hover:text-black/75"
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-90")}
                aria-hidden="true"
              />
              {t("高级")}
            </button>

            {advancedOpen ? (
              <div className="mt-2 rounded-[6px] bg-black/[0.02] p-3.5">
                <div className="flex items-center gap-1">
                  <label
                    className="text-left text-[12px] font-medium text-black/55"
                    htmlFor="lv-onboarding-clone"
                  >
                    {t("创建方式")}
                  </label>
                  {/* 问号：继承/不继承的差异只在用户真正好奇时才需要占版面 */}
                  <span className="group relative inline-flex">
                    <HelpCircle
                      className="h-3.5 w-3.5 cursor-help text-black/25 transition group-hover:text-black/45"
                      aria-hidden="true"
                    />
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-[264px] -translate-x-1/2 rounded-[6px] bg-[#1F2329] px-3 py-2.5 text-left text-[11px] leading-[17px] text-white shadow-[0_8px_28px_rgba(15,23,42,0.18)] group-hover:block"
                    >
                      {/* 提示必须跟着当前选择变 —— 选了空白创建还说「继承人设」是错的 */}
                      {isBlankCreate ? (
                        <>
                          <span className="block">
                            {t("仅继承主 Bot 当前主模型及其 Provider 凭据")}
                          </span>
                          <span className="mt-1.5 block text-white/55">
                            {t("不继承备用模型、人设、记忆、Skills、通道和定时任务")}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="block">
                            {t("继承模型、人设、技能、用户偏好和长期记忆")}
                          </span>
                          <span className="mt-1.5 block text-white/55">
                            {t("不继承当前对话、历史对话、定时任务、运行状态或通道连接")}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                </div>

                <Select
                  value={cloneOptions.value || BLANK_CREATE_VALUE}
                  onValueChange={(next) => cloneOptions.onChange(
                    // 哨兵值还原成空串：Radix Select 不接受空串作为 item value
                    next === BLANK_CREATE_VALUE ? "" : next,
                  )}
                >
                  <SelectTrigger
                    id="lv-onboarding-clone"
                    className="mt-1.5 h-10 w-full rounded-[6px] border-black/[0.09] bg-white px-3 text-[13px] text-black/[0.85] shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-black/20 focus:border-black/30"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-[260px]">
                    {/* 默认项排最前 */}
                    <SelectItem value={BLANK_CREATE_VALUE} textValue={t("空白创建")}>
                      {t("空白创建")}
                    </SelectItem>
                    {cloneOptions.choices.length > 0 ? <SelectSeparator /> : null}
                    {cloneOptions.choices.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id} textValue={t("复制 {{name}}", { name: choice.label })}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">
                            {t("复制 {{name}}", { name: choice.label })}
                          </span>
                          {choice.isDefault ? (
                            <span className="shrink-0 rounded-[3px] bg-black/[0.06] px-1.5 py-px text-[10px] font-medium text-black/45">
                              {t("主 Bot")}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => handleCreate()}
          className={cn(
            // 与上方表单项同宽（420px），视觉上形成一列
            "mt-5 w-full max-w-[420px] rounded-full px-5 py-2.5 text-sm font-medium transition",
            canSubmit
              ? "bg-black text-white hover:bg-black/85"
              : "cursor-not-allowed bg-black/[0.06] text-black/30",
          )}
        >
          {t("创建")}
        </button>
      </div>

      {/* 底部：个性化模板推荐 */}
      <TemplateRecommendations templates={templates} onPick={setActiveTemplate} />

      {activeTemplate ? (
        <TemplateDialog
          template={activeTemplate}
          onClose={() => setActiveTemplate(null)}
          onCreate={() => handleCreate(activeTemplate)}
        />
      ) : null}
    </div>
  );
};
