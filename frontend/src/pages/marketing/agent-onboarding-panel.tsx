/**
 * 新用户创建个人助手引导（静态 Demo）
 * ──────────────────────────────────────────────────────────────
 * 新用户从首页 hero 进入 /agents 后的首屏：先完成「创建个人助手」，
 * 才解锁总览与其余功能入口。
 *
 * 两条创建路径，都会先播「喂咖啡」动效再进 dashboard：
 *   A. 自填表单：头像（形状/配色可换） + 名字 + 标签 + 描述
 *   B. 个性化模板推荐：点卡片开详情弹窗，弹窗内「创建」
 *
 * 当前为**纯静态 Demo**：
 *   - 「是否已创建」状态存在 sessionStorage，不调任何后端接口；
 *   - 「创建」只播动效 + 写状态，不真正创建实例。
 * 接真实逻辑时替换 `useDemoOnboarding` 与 `handleCreate` 即可。
 *
 * 演示用法：
 *   - 进入引导态：/agents/overview?onboarding=1
 *   - 已创建态：点「创建」后自动进入
 */

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import {
  AVATAR_SHAPES,
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  GeometricAvatar,
  randomizeAvatarBatch,
  type AvatarShapeId,
} from "@/pages/marketing/agent-avatar-shapes";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
  runBuddySetupPlan,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import {
  BUDDY_DESCRIPTION_PLACEHOLDER,
  BUDDY_NAME_DEFAULT,
  BUDDY_TAGS_PLACEHOLDER,
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

  return (
    <section className="mt-7">
      <h3 className="mb-3 text-[13px] font-medium text-black/45">{t("建议")}</h3>

      {/* 横向滚动：卡片定宽 + snap，避免窄屏时被压扁。
          卡片无阴影，所以不需要额外的下内边距留溢出空间。 */}
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(template)}
            className="flex w-[248px] shrink-0 snap-start items-start gap-3 rounded-[4px] border border-black/[0.06] bg-white p-3 text-left transition hover:border-black/[0.12] hover:bg-black/[0.015]"
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
    </section>
  );
};

/* ──────────────────────────────── 引导面板 ──────────────────────────────── */

/** 沙箱就绪探测：最多等这么久（毫秒） */
const SANDBOX_READY_TIMEOUT_MS = 180_000;
/** 探测间隔 */
const SANDBOX_PROBE_INTERVAL_MS = 5_000;
/** 等 botId 的轮询间隔：路由导航很快，探密一点即可 */
const BOT_ID_PROBE_INTERVAL_MS = 200;

export const AgentOnboardingPanel = ({
  botId,
  profileId = "main",
  onCreated,
  execDebugCommand,
}: {
  /**
   * 目标 bot。订阅开通 instance 时后端已自带一个 default bot，
   * 所以这里是「对既有 bot 写配置」，而不是再新建一个。
   */
  botId: string;
  profileId?: string;
  /** 配置完成后回调 */
  onCreated: () => void;
  /** 沙箱命令执行器（由页面注入 repositories.bots.execDebugCommand） */
  execDebugCommand: SetupExec;
}) => {
  const t = useT();

  /** form：填表阶段；creating：写配置阶段 */
  const [phase, setPhase] = useState<"form" | "creating">("form");
  /** 待执行的配置（进入 creating 阶段时定下，避免后续表单改动影响执行） */
  const [pendingSetup, setPendingSetup] = useState<{
    profile: { name: string; tags: string; description: string };
    template?: AgentTemplate;
    avatar: { shapeId: string; color: string };
  } | null>(null);
  /** 步骤进度 */
  const [steps, setSteps] = useState<SetupStepState[]>([]);
  /** 阻断性错误（沙箱超时 / SOUL 写入失败） */
  const [fatalError, setFatalError] = useState<string | null>(null);
  /** 非阻断失败数，仅用于完成后提示 */
  const [partialFailureCount, setPartialFailureCount] = useState(0);

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

  const waitForSandbox = useCallback(
    async (targetBotId: string, isCancelled: () => boolean): Promise<boolean> => {
      const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (isCancelled()) return false;
        try {
          const result = await execDebugCommand(targetBotId, "true", { timeoutMs: 15_000 });
          if (result.exitCode === 0) return true;
        } catch {
          // 沙箱尚未就绪，继续等
        }
        await new Promise((resolve) => window.setTimeout(resolve, SANDBOX_PROBE_INTERVAL_MS));
      }
      return false;
    },
    [execDebugCommand],
  );

  /* ── 头像 ── */
  const [shapeId, setShapeId] = useState<AvatarShapeId>(DEFAULT_AVATAR_SHAPE);
  const [color, setColor] = useState(DEFAULT_AVATAR_COLOR);
  /** 当前展示的候选形状（「换一批」会重新抽） */
  const [shapeBatch, setShapeBatch] = useState(() => AVATAR_SHAPES.slice(0, 8));

  /* ── 表单 ── */
  const [name, setName] = useState(BUDDY_NAME_DEFAULT);
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");

  /* ── 模板弹窗 ── */
  const [activeTemplate, setActiveTemplate] = useState<AgentTemplate | null>(null);

  const canSubmit = name.trim().length > 0;

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
      const nextProfile = {
        name: (template ? template.name : name.trim()) || BUDDY_NAME_DEFAULT,
        // 标签只承载用户自己填的内容，模板不覆盖
        tags: tags.trim(),
        description: template ? template.description : description.trim(),
      };
      setActiveTemplate(null);
      setPendingSetup({
        profile: nextProfile,
        template,
        avatar: {
          shapeId: template ? template.shapeId : shapeId,
          color: template ? template.color : color,
        },
      });
      setPhase("creating");
    },
    [name, shapeId, color, tags, description],
  );

  /*
   * 真实配置流程：等沙箱可用 → 按计划写配置。
   *
   * 放在 effect 里而非 handler 里，是为了组件卸载时能通过 cancelled 中止，
   * 避免用户中途离开后还在往沙箱里写东西。
   */
  useEffect(() => {
    if (phase !== "creating" || !pendingSetup) return undefined;

    let cancelled = false;

    const run = async () => {
      try {
        /*
         * 0. 等 botId 到位。
         *
         * 创建期引导会早于 `?creating=<botId>` 落到 URL 就渲染出来（否则中间
         * 那一帧会漏回咖啡杯）。填表通常远慢于路由，所以点「创建」时 botId
         * 基本已就绪；但用户手速极快时仍可能为空，这里等一下而不是直接失败。
         */
        const targetBotId = await waitForBotId(() => cancelled);
        if (cancelled) return;
        if (!targetBotId) {
          throw new Error(t("实例尚未就绪，请稍后在设置页重试配置"));
        }

        // 1. 等实例真正可执行命令 —— status 变 active 不等于沙箱就绪
        const ready = await waitForSandbox(targetBotId, () => cancelled);
        if (cancelled) return;
        if (!ready) {
          throw new Error(t("实例尚未就绪，请稍后在设置页重试配置"));
        }

        // 2. 按计划写 SOUL / 用户画像 / 技能 / 定时任务
        const plan = buildBuddySetupPlan({
          profile: pendingSetup.profile,
          template: pendingSetup.template,
          profileId,
          avatar: pendingSetup.avatar,
          timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
        });
        setSteps(plan.map((step) => ({ step, status: "pending" as const })));

        const result = await runBuddySetupPlan({
          botId: targetBotId,
          steps: plan,
          exec: execDebugCommand,
          onProgress: (states) => {
            if (!cancelled) setSteps(states);
          },
          shouldCancel: () => cancelled,
        });
        if (cancelled) return;

        // 非阻断步骤失败：不挡流程，落个提示让用户知道去哪补
        if (result.failures.length > 0) {
          setPartialFailureCount(result.failures.length);
        }
        onCreated();
      } catch (error) {
        if (cancelled) return;
        setFatalError(error instanceof Error ? error.message : String(error));
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, pendingSetup, profileId, waitForBotId, waitForSandbox, execDebugCommand, onCreated, t]);

  /** 卡片上不重复展示当前选中的模板 */
  const templates = useMemo(() => DEMO_TEMPLATES, []);

  if (phase === "creating") {
    return (
      <CreatingLoadingView
        errorMessage={fatalError}
        steps={steps}
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
              aria-label={shape.label}
              aria-pressed={shape.id === shapeId}
              onClick={() => setShapeId(shape.id)}
              className={cn(
                "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px] border transition",
                shape.id === shapeId
                  ? "border-black/25 bg-black/[0.04]"
                  : "border-transparent hover:bg-black/[0.03]",
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
            className="mt-1 w-full rounded-[3px] border border-black/[0.1] px-3 py-2 text-sm font-medium text-black/[0.88] outline-none transition focus:border-black/25"
          />
        </div>

        <div className="mt-3 w-full max-w-[420px]">
          <label
            className="block text-left text-[11px] font-medium text-black/40"
            htmlFor="lv-onboarding-tags"
          >
            {t("标签")}
            <span className="ml-1 text-black/30">{t("（可选）")}</span>
          </label>
          <input
            id="lv-onboarding-tags"
            value={tags}
            placeholder={BUDDY_TAGS_PLACEHOLDER}
            onChange={(event) => setTags(event.target.value)}
            className="mt-1 w-full rounded-[3px] border border-black/[0.1] px-3 py-2 text-sm text-black/[0.88] outline-none transition placeholder:text-black/30 focus:border-black/25"
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
            placeholder={BUDDY_DESCRIPTION_PLACEHOLDER}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-1 w-full resize-none rounded-[3px] border border-black/[0.1] px-3 py-2 text-[13px] leading-5 text-black/70 outline-none transition placeholder:text-black/30 focus:border-black/25"
          />
        </div>

        {/* TODO(demo): 接真实创建逻辑 */}
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
