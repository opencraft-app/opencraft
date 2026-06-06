/**
 * AI 搭子面板（v0.8）
 *
 * 在 Hermes 实例 Settings 内，从 SkillHub 公共接口拉取 Soul（人设）目录，
 * 渲染成 9 张抽卡槽（3×3 网格）：默认全部为空白卡背，每抽到一张人设填入下一格。
 * 视觉对齐 SkillHub `/hermes/edit-soul` —— 抽到的卡用 SoulFaceCard（bgUrl 全卡面），
 * 没抽到的用 CardBack（灰底 + 拼图 icon）。
 *
 * 抽卡数据策略：**前端从公共 souls 池 Math.random**，且自动剔除已抽到的 slug，
 * 每次抽出新一张。不调 SkillHub 的 draw 接口（鉴权方案待落地）。
 *
 * 数据来源：`@/lib/skillhub-api`，跨域直连 https://lightmake.cloud 的
 * 公共接口（lightclaw.tech 与 EO Pages 预览域名都在其 CORS 白名单内）。
 *
 * 注：AI 搭子当前仅保留 Soul（人设）浏览与抽卡能力。
 */

import { AlertCircle, AlertTriangle, Check, ClipboardCheck, Dice5, Download, ExternalLink, Loader2, RotateCcw, Sparkles, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useT } from "@/i18n/t";
import { useRepositories } from "@/contexts/repository-context";
import { useAsyncResource } from "@/services/use-async-resource";
import { DrawSoulModal } from "@/pages/marketing/openclaw-buddy-draw-modal";
import { SoulTestModal } from "@/pages/marketing/openclaw-buddy-soul-test-modal";
import {
  CardBack,
  SoulFaceCard,
  SoulSpecRenderer,
} from "@/pages/marketing/openclaw-buddy-cards";
import {
  fetchSoulDetail,
  fetchSouls,
  type SkillHubSoul,
} from "@/lib/skillhub-api";
import { getSoulSpec, buildSoulMd } from "@/lib/soul-interpretations";
import { SoulSpecPanel } from "@/components/soul-spec-panel";
import {
  loadBuddyState,
  saveBuddyState,
  VibebaseError,
} from "@/lib/buddy-storage";

const PANEL_CARD_STYLE: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.06)",
  background: "#ffffff",
  boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
};

const ACTION_TOOLTIP_CLASS = "pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100";

const ACTION_TOOLTIP_ARROW_CLASS = "absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white";

const UNAPPLIED_TOOLTIP_CLASS = "pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within/unapplied:opacity-100 group-hover/unapplied:opacity-100";

/** 抽卡槽位数上限（4 列 × 2 行 = 8 张） */
const MAX_DRAWS = 8;

function UnappliedSoulIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth="1.45"
        opacity="0.62"
      />
      <path
        d="M4.55 11.45 11.45 4.55"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BuddyPanel({
  botId,
}: {
  /** 当前 settings 选中的 bot id；null 时降级为浏览器下载 soul.md */
  botId?: string | null;
} = {}) {
  const t = useT();
  const repositories = useRepositories();
  const [previewSoulSlug, setPreviewSoulSlug] = useState<string | null>(null);

  // 持久化：状态走 Vibebase（用户级 KV，跨设备一致）。
  // 加载流程：mount / 切 botId → 异步拉取 → 期间显示 loading 占位（空抽卡盘 + 转圈）。
  // 写入流程：drawnSouls / appliedSlug 变化触发防抖（500ms）后异步推送。
  // 错误处理：401 → 切到"未登录"提示态，禁用抽卡；其他错误 → 顶部 error toast。
  type LoadStatus = "loading" | "loaded" | "unauthorized" | "error";
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");

  /** 已抽到的人设，按抽到顺序排列，去重 by slug，最多 MAX_DRAWS 张 */
  const [drawnSouls, setDrawnSouls] = useState<SkillHubSoul[]>([]);
  /** 抽卡弹窗开关 */
  const [drawOpen, setDrawOpen] = useState(false);
  /** Soul 人格测试弹窗开关 */
  const [soulTestOpen, setSoulTestOpen] = useState(false);

  /** 注入结果 toast。idle 不显示；applying 期间禁掉重复点击。
   *  fallback: botId 缺失 / sandbox 写入失败，降级浏览器下载。
   *  error: 拉取详情失败 / 未选中卡。 */
  type ToastState =
    | { kind: "idle" }
    | { kind: "applying" }
    | { kind: "fallback"; message: string }
    | { kind: "error"; message: string };
  const [toast, setToast] = useState<ToastState>({ kind: "idle" });
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((next: ToastState, autoHideMs = 3500) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(next);
    if (next.kind !== "idle" && next.kind !== "applying" && autoHideMs > 0) {
      toastTimerRef.current = window.setTimeout(() => {
        setToast({ kind: "idle" });
        toastTimerRef.current = null;
      }, autoHideMs);
    }
  }, []);
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  // souls 列表是抽卡 modal 的候选池数据源 —— 提到这一层统一拉取，
  // 避免 SoulSlotGrid 内部 fetch 一次、DrawModal 再单独 fetch 一次。
  const soulsFetcher = useCallback(() => fetchSouls({ page: 1, pageSize: 30 }), []);
  const soulsResource = useAsyncResource(soulsFetcher, []);
  const souls = soulsResource.data?.souls ?? [];

  const drawnSlugs = drawnSouls.map((s) => s.slug);
  const isAtMax = drawnSouls.length >= MAX_DRAWS;

  /** 标记正在被重抽的 slug。null 表示当前不是重抽（普通抽卡）。 */
  const [rerollingSlug, setRerollingSlug] = useState<string | null>(null);

  const handlePickFromDraw = useCallback(
    (soul: SkillHubSoul) => {
      setDrawnSouls((prev) => {
        // 重抽：替换原位置；防御性 dedupe（同一张再次抽到则保持原状即可）
        if (rerollingSlug) {
          const idx = prev.findIndex((s) => s.slug === rerollingSlug);
          if (idx === -1) return prev;
          if (prev.some((s, i) => i !== idx && s.slug === soul.slug)) return prev;
          const copy = prev.slice();
          copy[idx] = soul;
          return copy;
        }
        // 新抽：追加到末尾
        if (prev.some((s) => s.slug === soul.slug)) return prev; // dedupe（防御）
        if (prev.length >= MAX_DRAWS) return prev; // 上限保护
        return [...prev, soul];
      });
      setRerollingSlug(null);
      setDrawOpen(false);
    },
    [rerollingSlug],
  );

  const handleOpenDraw = useCallback(() => {
    if (isAtMax) return;
    setRerollingSlug(null); // 普通抽卡前确保清掉重抽标记
    setDrawOpen(true);
  }, [isAtMax]);

  const handleUseTestSoul = useCallback(
    (soul: SkillHubSoul) => {
      if (loadStatus !== "loaded") {
        showToast({
          kind: "error",
          message: t("搭子状态未加载成功，暂时无法保存推荐人设，请先重试加载状态"),
        });
        return false;
      }

      const alreadyDrawn = drawnSouls.some((item) => item.slug === soul.slug);
      if (!alreadyDrawn && drawnSouls.length >= MAX_DRAWS) {
        showToast({ kind: "error", message: t("卡槽已满，请先删除一张人设，再使用测试推荐") });
        return false;
      }

      if (!alreadyDrawn) {
        setDrawnSouls((prev) => {
          if (prev.some((item) => item.slug === soul.slug)) return prev;
          if (prev.length >= MAX_DRAWS) return prev;
          return [...prev, soul];
        });
      }
      setSelectedSlug(soul.slug);
      return true;
    },
    [drawnSouls, loadStatus, showToast, t],
  );

  /** 重抽某张已抽到的卡：复用抽卡 modal 流程（翻牌动画 → reveal → 替换原位） */
  const handleReroll = useCallback((slug: string) => {
    setRerollingSlug(slug);
    setDrawOpen(true);
  }, []);

  /** 重抽时是否可用：候选池非空才允许 */
  const canReroll = souls.length > drawnSouls.length;
  const canOpenSoulTest = !isAtMax;

  /** 选中态（单选）：选中后右上角显示勾，可"应用到 Agent" */
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  /** 上一次成功应用到 Agent 的 slug —— 用于按钮上展示「已应用」反馈 */
  const [appliedSlug, setAppliedSlug] = useState<string | null>(null);

  // 切 botId：清空当前 UI → 异步从 Vibebase 拉取该 bot 的状态。
  // 用 reqId 防止快速切换时的回调竞态（旧 promise 后到不能覆盖新 bot 的数据）。
  const loadReqIdRef = useRef(0);
  // 记录"已知与服务端一致"的快照（按 botId 维度）。save effect 做内容比对，
  // 与该快照相同则跳过，避免 load 完成后的"自我同步"PUT。
  // 比 ref 旗子更稳：StrictMode 双 mount / 切 bot 重入都不会漏判 / 多判。
  const syncedSnapshotRef = useRef<{ botId: string | null | undefined; data: string } | null>(null);
  useEffect(() => {
    const reqId = ++loadReqIdRef.current;
    setLoadStatus("loading");
    setDrawnSouls([]);
    setAppliedSlug(null);
    setSelectedSlug(null);

    loadBuddyState(botId)
      .then((state) => {
        if (loadReqIdRef.current !== reqId) return; // 已被新请求超车
        const drawnSouls = state?.drawnSouls ?? [];
        const appliedSlug = state?.appliedSlug ?? null;
        // 同步快照：与 setState 同一批，确保 save effect 看到的快照已是最新
        syncedSnapshotRef.current = {
          botId,
          data: JSON.stringify({ drawnSouls, appliedSlug }),
        };
        setDrawnSouls(drawnSouls);
        setAppliedSlug(appliedSlug);
        setLoadStatus("loaded");
      })
      .catch((err: unknown) => {
        if (loadReqIdRef.current !== reqId) return;
        if (err instanceof VibebaseError && err.isUnauthorized) {
          setLoadStatus("unauthorized");
          return;
        }
        // eslint-disable-next-line no-console
        console.error("[buddy] loadBuddyState failed:", err);
        setLoadStatus("error");
      });
  }, [botId]);

  // 持久化：drawnSouls / appliedSlug 变化时防抖 500ms 推送 Vibebase。
  // - 加载未完成不写（避免空数据覆盖云端）
  // - 与已同步快照相同时不写（避免 load 完成后的"自我同步"PUT）
  // - 401 / error 状态不写（写也是 401 / error 死循环）
  // - 写入失败仅 console 报警，不阻塞 UI；下一次变化会重试
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (loadStatus !== "loaded") return;
    const currentData = JSON.stringify({ drawnSouls, appliedSlug });
    const synced = syncedSnapshotRef.current;
    if (synced && synced.botId === botId && synced.data === currentData) {
      // 当前数据已和服务端一致（来自 load，或上次 save 成功）→ 跳过
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveBuddyState(botId, { drawnSouls, appliedSlug })
        .then(() => {
          // 写入成功后更新快照，让 StrictMode 双 mount / 同值再触发不会重复 PUT
          syncedSnapshotRef.current = { botId, data: currentData };
        })
        .catch((err: unknown) => {
          if (err instanceof VibebaseError && err.isUnauthorized) {
            // session 中途失效（比如 cookie 过期）→ 切到未登录态
            setLoadStatus("unauthorized");
            return;
          }
          // 服务端守门：buddy 抽卡上限（≥9 张），落地为友好中文 toast
          if (
            err instanceof VibebaseError &&
            err.code === "buddy_drawn_souls_too_many"
          ) {
            showToast({
              kind: "error",
              message: t("最多保留 8 张人设卡片，请先丢弃几张再试"),
            });
            return;
          }
          // eslint-disable-next-line no-console
          console.error("[buddy] saveBuddyState failed:", err);
          showToast({
            kind: "error",
            message: t("保存搭子状态失败，请检查网络后重试"),
          });
        });
    }, 500);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [botId, drawnSouls, appliedSlug, loadStatus, showToast, t]);

  // unmount：把 pending 的 save 立即 flush 一次，避免用户刚抽完就关页面丢数据。
  // 用 ref 跟踪最新值，确保 unmount cleanup 拿到的不是首次 render 的旧 closure。
  const latestSaveRef = useRef({ botId, drawnSouls, appliedSlug, loadStatus });
  latestSaveRef.current = { botId, drawnSouls, appliedSlug, loadStatus };
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const latest = latestSaveRef.current;
        // 仅在已 loaded（即数据可信）时 flush；其余状态直接放弃
        if (latest.loadStatus === "loaded") {
          saveBuddyState(latest.botId, {
            drawnSouls: latest.drawnSouls,
            appliedSlug: latest.appliedSlug,
          }).catch(() => {
            /* unmount 时无 UI 可提示，fire-and-forget */
          });
        }
      }
    };
  }, []);

  /** 切换选中：再点一次取消选中 */
  const handleToggleSelect = useCallback((slug: string) => {
    setSelectedSlug((prev) => (prev === slug ? null : slug));
  }, []);

  // 当选中卡被重抽掉了，自动清空选中态
  useEffect(() => {
    if (selectedSlug && !drawnSouls.some((s) => s.slug === selectedSlug)) {
      setSelectedSlug(null);
    }
  }, [drawnSouls, selectedSlug]);

  // 当已注入卡被重抽掉，"已注入"徽章应一并清空（避免错位到其它卡）
  // 注意：被覆盖的旧 SOUL.md 已经备份在 sandbox，前端只是失去本地 UI 状态。
  useEffect(() => {
    if (appliedSlug && !drawnSouls.some((s) => s.slug === appliedSlug)) {
      setAppliedSlug(null);
    }
  }, [drawnSouls, appliedSlug]);

  /** 注入人设：
   *  - 有 botId → 走 `debug/exec` 一把梭：备份旧 SOUL.md（若存在）→ 写入新 SOUL.md
   *    路径 `${HOME}/.hermes/SOUL.md`（hermes-agent 运行时读这里，不是
   *    `~/.openclaw/workspace/SOUL.md` —— 那是 openclaw runtime 的约定）。
   *    走 raw bash 而非 `workspace/files`：后者写死 `${HOME}/.openclaw/workspace`
   *    且强制白名单文件名，hermes 场景两个限制都不适用。
   *  - 无 botId → 浏览器下载 soul.md（兜底）
   *  内容：用 SkillHub /api/v1/souls/<slug> 的 content 拼装，对齐 zip 包格式。
   */
  const handleApply = useCallback(async () => {
    if (!selectedSlug) return; // 按钮已 disabled，理论上点不到
    if (toast.kind === "applying") return; // 防重复点击
    const soul = drawnSouls.find((s) => s.slug === selectedSlug);
    if (!soul) return;

    showToast({ kind: "applying" }, 0);

    // 最短转圈时长：避免极快返回时按钮一闪而过、用户无感知。
    // 每个 return 出口前都 await `ensureMinSpin()` 把剩余时间补齐。
    const startedAt = Date.now();
    const MIN_SPIN_MS = 2000;
    const ensureMinSpin = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = MIN_SPIN_MS - elapsed;
      return remaining > 0
        ? new Promise<void>((resolve) => window.setTimeout(resolve, remaining))
        : Promise.resolve();
    };

    let md: string;
    try {
      const detail = await fetchSoulDetail(soul.slug);
      md = buildSoulMd({
        slug: soul.slug,
        displayName: soul.displayName,
        summary: soul.summary,
        content: detail.content ?? "",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[buddy] fetch soul detail failed:", err);
      await ensureMinSpin();
      showToast({
        kind: "error",
        message: t("拉取人设详情失败，请检查网络后重试"),
      });
      return;
    }

    // 路径 A：写入到当前 bot 工作区的 SOUL.md（覆盖前先备份）
    if (botId) {
      try {
        // UTF-8 → base64（避免 btoa 直接吃中文炸 latin1）
        const mdBytes = new TextEncoder().encode(md);
        let binary = "";
        for (const b of mdBytes) binary += String.fromCharCode(b);
        const mdBase64 = btoa(binary);

        // 时间戳：2026-05-20T14_13_05-123（冒号点都换掉，文件名安全）
        const ts = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .replace("Z", "");

        // 一把梭：mkdir → 备份到独立子目录 → heredoc base64 解码写入
        // 路径：${HOME}/.hermes/SOUL.md（hermes-agent 运行时实际读取位置）
        // 备份：${HOME}/.hermes/.soul-backups/<ts>.md（跟主文件分开，便于 ls 查看）
        const bash = [
          'set -e',
          'WORKSPACE_DIR="${HOME}/.hermes"',
          'BACKUP_DIR="$WORKSPACE_DIR/.soul-backups"',
          'mkdir -p "$WORKSPACE_DIR" "$BACKUP_DIR"',
          'TARGET="$WORKSPACE_DIR/SOUL.md"',
          `BACKUP="$BACKUP_DIR/${ts}.md"`,
          'if [ -s "$TARGET" ]; then cp "$TARGET" "$BACKUP"; fi',
          "cat <<'__CTL_SOUL_EOF__' | base64 -d > \"$TARGET\"",
          mdBase64,
          '__CTL_SOUL_EOF__',
        ].join('\n');

        const result = await repositories.bots.execDebugCommand(botId, bash);
        if (result.exitCode !== 0) {
          throw new Error(`exec exit ${result.exitCode}: ${result.output}`);
        }
        await ensureMinSpin();
        setAppliedSlug(selectedSlug);
        // hermes-agent 在 session 启动时一次性快照 SOUL.md，已存在 session 不感知
        // 文件变化，弹一个确认对话框提示用户在 IM 里输入 /new 开新 session 让新人设生效。
        setToast({ kind: "idle" });
        setConfirmState({ kind: "applySuccess" });
        return;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[buddy] inject SOUL.md to bot failed, fallback to download:", err);
        // 写入失败 → 不打断用户，降级走浏览器下载
      }
    }

    // 路径 B：浏览器下载兜底
    await ensureMinSpin();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "soul.md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setAppliedSlug(selectedSlug);
    // 区分两种降级原因：botId 为空（用户未选 bot） vs sandbox 写入失败
    showToast({
      kind: "fallback",
      message: botId
        ? t("无法写入 Agent 沙箱，已下载 soul.md 到本地")
        : t("当前未选中 Agent，已下载 soul.md 到本地"),
    });
  }, [selectedSlug, drawnSouls, botId, repositories, toast.kind, showToast, t]);

  /**
   * 清除 Bot 沙箱里当前的 SOUL.md（让 hermes-agent 回到无人设状态）。
   * 删之前再备份一次到 `.soul-backups/<ts>.removed.md`，万一用户后悔可以手动恢复。
   * - 没有 botId 或 sandbox 写入失败 → 静默忽略，前端 UI 自己清就够了
   * - 有 botId 但 sandbox 调用失败 → console.error，不阻塞 UI 流程
   */
  const clearSandboxSoul = useCallback(async () => {
    if (!botId) return;
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    // 防御性：ts 只含 [0-9_-]，避免未来上游污染导致 shell 注入
    if (!/^[0-9_-]+$/.test(ts)) return;
    const bash = [
      "set -eo pipefail",
      'WORKSPACE_DIR="${HOME}/.hermes"',
      'BACKUP_DIR="$WORKSPACE_DIR/.soul-backups"',
      'TARGET="$WORKSPACE_DIR/SOUL.md"',
      // 只有 SOUL.md 存在且非空才走 backup → rm 流程，否则直接结束
      'if [ -s "$TARGET" ]; then',
      '  mkdir -p "$BACKUP_DIR"',
      `  cp "$TARGET" "$BACKUP_DIR/${ts}.removed.md"`,
      '  rm -f "$TARGET"',
      "fi",
    ].join("\n");
    try {
      const result = await repositories.bots.execDebugCommand(botId, bash);
      if (result.exitCode !== 0) {
        throw new Error(`exec exit ${result.exitCode}: ${result.output}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[buddy] clearSandboxSoul failed:", err);
    }
  }, [botId, repositories]);

  /**
   * 弹窗状态机：
   * - idle：无弹窗
   * - deleteOne：删除单张卡（带 slug，记是否已注入用于显示文案差异）
   * - applySuccess：注入成功后提示用户 /new 开启新会话
   */
  type ConfirmState =
    | { kind: "idle" }
    | { kind: "deleteOne"; slug: string; soulName: string; isApplied: boolean }
    | { kind: "applySuccess" };
  const [confirmState, setConfirmState] = useState<ConfirmState>({ kind: "idle" });

  /**
   * 删除单张抽到的人设（弹 confirm）。
   * - 普通卡 / 已注入卡 都弹确认（"删除"是破坏性操作，统一加 confirm 更稳）
   * - 真正执行落到 confirmDeleteOne
   */
  const handleDeleteOne = useCallback(
    (slug: string) => {
      const soul = drawnSouls.find((s) => s.slug === slug);
      if (!soul) return;
      setConfirmState({
        kind: "deleteOne",
        slug,
        soulName: soul.displayName,
        isApplied: slug === appliedSlug,
      });
    },
    [drawnSouls, appliedSlug],
  );

  /** confirm 回调：真正执行单张删除。 */
  const confirmDeleteOne = useCallback(
    async (slug: string, isAppliedTarget: boolean) => {
      setConfirmState({ kind: "idle" });
      setDrawnSouls((prev) => prev.filter((s) => s.slug !== slug));
      // applied/selected 的清理由 useEffect 自动处理（drawnSouls 变化触发）
      if (isAppliedTarget) {
        await clearSandboxSoul();
      }
    },
    [clearSandboxSoul],
  );

  const isApplied = selectedSlug !== null && selectedSlug === appliedSlug;
  const isApplyDisabled = !selectedSlug || toast.kind === "applying" || loadStatus !== "loaded";

  return (
    <div className="lv-buddy-panel relative overflow-hidden rounded-2xl" style={PANEL_CARD_STYLE}>
      <InjectToast state={toast} onClose={() => setToast({ kind: "idle" })} t={t} />
      {/* 顶部标题 slogan + 右上角 SkillHub 入口 */}
      <div className="lv-buddy-panel__header relative flex items-center justify-center px-6 pt-5 pb-3">
        <h2
          className="lv-buddy-panel__title flex items-center gap-2 text-xl font-semibold"
          style={{
            letterSpacing: "-0.2px",
            backgroundImage:
              "linear-gradient(95deg, rgba(0,0,0,0.92) 0%, #6B4FE0 45%, #F4B43A 100%)",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            color: "transparent",
            WebkitTextFillColor: "transparent",
          }}
        >
          <Sparkles
            className="h-5 w-5 animate-pulse"
            style={{ color: "#6B4FE0" }}
          />
          {t("为你的 Agent 解锁独特灵魂，让它从此与众不同")}
        </h2>
      </div>
      <a
        href="https://skillhub.cn/hermes"
        target="_blank"
        rel="noopener noreferrer"
        className="lv-buddy-panel__source inline-flex shrink-0 items-center gap-1.5 text-xs font-medium transition-colors hover:opacity-80"
        style={{ color: "rgba(0,0,0,0.55)" }}
      >
        {t("灵感来自 SkillHub")}
        <ExternalLink className="h-3 w-3" />
      </a>

      {/* 内容区：6 格抽卡槽，下方接进度 chip 靠右展示，避免覆盖卡片本身 */}
      <div className="lv-buddy-panel__body px-6 pt-2 pb-2">
        {loadStatus === "unauthorized" ? (
          <UnauthorizedState />
        ) : loadStatus === "error" ? (
          <ErrorState
            message={t("搭子状态加载失败，抽卡和注入暂不可用，但仍可先做人格测试")}
            onRetry={() => {
              // 触发 useEffect 重跑：直接 ++reqId 不行（不会触发 effect），用 botId-tick
              // 兜底：直接刷一次页面对应的 effect 依赖
              loadReqIdRef.current++;
              setLoadStatus("loading");
              loadBuddyState(botId)
                .then((state) => {
                  setDrawnSouls(state?.drawnSouls ?? []);
                  setAppliedSlug(state?.appliedSlug ?? null);
                  setLoadStatus("loaded");
                })
                .catch((err: unknown) => {
                  if (err instanceof VibebaseError && err.isUnauthorized) {
                    setLoadStatus("unauthorized");
                    return;
                  }
                  setLoadStatus("error");
                });
            }}
          />
        ) : (
          <SoulSlotGrid
            drawnSouls={drawnSouls}
            // souls 池在拉取 + 自身 buddy state 在加载，任一未完成都给 loading
            loading={
              loadStatus === "loading"
              || (soulsResource.loading && souls.length === 0)
            }
            error={souls.length === 0 ? soulsResource.error : null}
            onReload={soulsResource.reload}
            onClickFilled={handleToggleSelect}
            onClickEmpty={handleOpenDraw}
            onReroll={handleReroll}
            onDelete={handleDeleteOne}
            canReroll={canReroll}
            selectedSlug={selectedSlug}
            appliedSlug={appliedSlug}
            onPreview={(slug) => setPreviewSoulSlug(slug)}
          />
        )}
      </div>

      {/* 卡片下方：抽取人设 + Soul 测试 + 应用到 Agent；小屏时进度操作自然换行 */}
      <div className="lv-buddy-panel__actions relative mx-auto flex max-w-[816px] items-center justify-center gap-3 px-0 py-5">
        <div className="lv-buddy-panel__action-buttons flex flex-wrap items-center justify-center gap-3">
          <div className="group relative inline-flex">
            <button
              type="button"
              onClick={handleOpenDraw}
              disabled={souls.length === 0 || isAtMax || loadStatus !== "loaded"}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              style={{
                background: "rgba(0,0,0,0.04)",
                color: "rgba(0,0,0,0.85)",
                border: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <Dice5 className="h-4 w-4" />
              {t("随机抽取人设")}
            </button>
            {isAtMax && (
              <div
                className={ACTION_TOOLTIP_CLASS}
                role="tooltip"
              >
                {t("已抽满 8 张")}
                <span
                  className={ACTION_TOOLTIP_ARROW_CLASS}
                  aria-hidden
                />
              </div>
            )}
          </div>
          <div className="group relative inline-flex">
            <button
              type="button"
              onClick={() => setSoulTestOpen(true)}
              disabled={!canOpenSoulTest}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              style={{
                background: "linear-gradient(95deg, rgba(255,166,0,0.16) 0%, rgba(107,79,224,0.14) 100%)",
                color: "rgba(0,0,0,0.85)",
                border: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <ClipboardCheck className="h-4 w-4" />
              {t("答题测试人设")}
            </button>
            {isAtMax && (
              <div
                className={ACTION_TOOLTIP_CLASS}
                role="tooltip"
              >
                {t("已抽满 8 张")}
                <span
                  className={ACTION_TOOLTIP_ARROW_CLASS}
                  aria-hidden
                />
              </div>
            )}
          </div>
          <div className="group relative inline-flex">
            <button
              type="button"
              onClick={handleApply}
              disabled={isApplyDisabled}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              style={
                isApplyDisabled
                  ? {
                      background: "rgba(0,0,0,0.04)",
                      color: "rgba(0,0,0,0.85)",
                      border: "1px solid rgba(0,0,0,0.06)",
                    }
                  : {
                      background: "rgba(0,0,0,0.90)",
                      color: "#ffffff",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.10)",
                    }
              }
            >
              {toast.kind === "applying" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isApplied ? (
                <RotateCcw className="h-4 w-4" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              {toast.kind === "applying"
                ? t("注入中…")
                : isApplied
                  ? t("重新注入")
                  : t("注入人设")}
            </button>
            {/* 自定义浮卡：仅 disabled 因「未选中」时立即浮出，避开原生 title 延迟 */}
            {!selectedSlug && (
              <div
                className={ACTION_TOOLTIP_CLASS}
                role="tooltip"
              >
                {t("请先选择人设，再注入")}
                <span
                  className={ACTION_TOOLTIP_ARROW_CLASS}
                  aria-hidden
                />
              </div>
            )}
          </div>
        </div>
        {drawnSouls.length > 0 && (
          <div className="lv-buddy-panel__progress absolute right-0 top-1/2 flex -translate-y-1/2 items-center">
            <ProgressChip drawn={drawnSouls.length} max={MAX_DRAWS} />
          </div>
        )}
      </div>

      <DrawSoulModal
        open={drawOpen}
        souls={souls}
        // 重抽时把"被重抽的卡"从已抽列表里移除，让其他池里的 soul 可以替补它的位置
        drawnSlugs={rerollingSlug ? drawnSlugs.filter((s) => s !== rerollingSlug) : drawnSlugs}
        onClose={() => {
          setDrawOpen(false);
          setRerollingSlug(null);
        }}
        onPick={handlePickFromDraw}
      />

      <SoulTestModal
        open={soulTestOpen}
        souls={souls}
        maxDrawsReached={isAtMax}
        drawnSlugs={drawnSlugs}
        saveDisabledReason={
          loadStatus === "loaded"
            ? null
            : t("搭子状态未加载成功，暂时无法保存推荐人设，请先重试加载状态")
        }
        onClose={() => setSoulTestOpen(false)}
        onUseSoul={handleUseTestSoul}
      />

      {previewSoulSlug && (
        <SoulPreviewModal slug={previewSoulSlug} onClose={() => setPreviewSoulSlug(null)} />
      )}

      {/* 删除确认弹窗（视觉对齐 settings 页 _DeleteConfirmDialog） */}
      <AnimatePresence>
        {confirmState.kind === "deleteOne" && (
          <ConfirmDialog
            key="confirm-delete-one"
            title={t("确认删除人设")}
            message={
              confirmState.isApplied
                ? t("该人设已注入 Agent，删除会同时取消 Agent 当前人设，确认？")
                : t("确定要从抽卡盘里删除「{{name}}」吗？此操作不可撤销。", {
                  name: confirmState.soulName,
                })
            }
            confirmLabel={t("确认删除")}
            onCancel={() => setConfirmState({ kind: "idle" })}
            onConfirm={() => confirmDeleteOne(confirmState.slug, confirmState.isApplied)}
          />
        )}
        {confirmState.kind === "applySuccess" && (
          <InfoDialog
            key="info-apply-success"
            title={t("人设已注入")}
            message={t("请在与 Agent 的对话中输入 /new 开启新会话，让新人设生效。")}
            buttonLabel={t("我知道了")}
            onClose={() => setConfirmState({ kind: "idle" })}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── 注入结果 toast ──────────────────────────────────────────────────────────
// fallback（橙，下载兜底）/ error（红，失败）。
// applying 由按钮自带 spinner，不重复弹。3.5s 自动消失。

function InjectToast({
  state,
  onClose,
  t,
}: {
  state:
    | { kind: "idle" }
    | { kind: "applying" }
    | { kind: "fallback"; message: string }
    | { kind: "error"; message: string };
  onClose: () => void;
  t: (s: string) => string;
}) {
  // applying 状态：按钮自己有 spinner，toast 不重复显示
  if (state.kind === "idle" || state.kind === "applying") return null;

  // 颜色 / 图标按状态切换
  let bg: string;
  const fg = "#ffffff";
  let icon: React.ReactNode;
  let text: string;

  if (state.kind === "fallback") {
    bg = "#B7791F";
    icon = <Download className="h-4 w-4" />;
    text = state.message;
  } else {
    // error
    bg = "#B91C1C";
    icon = <AlertCircle className="h-4 w-4" />;
    text = state.message;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto inline-flex max-w-[90%] items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg"
        style={{
          background: bg,
          color: fg,
          boxShadow: "0 8px 24px rgba(15,23,42,0.18)",
        }}
      >
        {icon}
        <span className="truncate">{text}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full transition hover:bg-white/15"
          aria-label={t("关闭")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── 进度 chip ──────────────────────────────────────────────────────────────

function ProgressChip({ drawn, max }: { drawn: number; max: number }) {
  const t = useT();
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
      style={{ background: "rgba(0,0,0,0.05)", color: "rgba(0,0,0,0.65)" }}
    >
      <span style={{ color: "rgba(0,0,0,0.45)" }}>{t("已抽")}</span>
      <span>
        {drawn}/{max}
      </span>
    </div>
  );
}

// ─── 9 格抽卡槽 ─────────────────────────────────────────────────────────────

function SoulSlotGrid({
  drawnSouls,
  loading,
  error,
  onReload,
  onClickFilled,
  onClickEmpty,
  onReroll,
  onDelete,
  canReroll,
  selectedSlug,
  appliedSlug,
  onPreview,
}: {
  drawnSouls: SkillHubSoul[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClickFilled: (slug: string) => void;
  onClickEmpty: () => void;
  onReroll: (slug: string) => void;
  onDelete: (slug: string) => void;
  canReroll: boolean;
  selectedSlug: string | null;
  appliedSlug: string | null;
  onPreview: (slug: string) => void;
}) {
  if (loading) return <CenterLoader />;
  if (error) return <ErrorState message={error} onRetry={onReload} />;
  return (
    // 网格 max-w 锁在 816px 居中，4 列下单卡 ≈ 192×269，最多展示 8 张抽卡槽。
    // 容器在更窄视口里会自然缩小，cell 跟着变小。
    <div className="lv-buddy-panel__grid mx-auto grid max-w-[816px] grid-cols-4 gap-4">
      {Array.from({ length: MAX_DRAWS }).map((_, i) => {
        const soul = drawnSouls[i];
        if (soul) {
          return (
            <FilledSlot
              key={soul.slug}
              soul={soul}
              selected={selectedSlug === soul.slug}
              applied={appliedSlug === soul.slug}
              onClick={() => onClickFilled(soul.slug)}
              onReroll={() => onReroll(soul.slug)}
              onDelete={() => onDelete(soul.slug)}
              canReroll={canReroll}
              onPreview={() => onPreview(soul.slug)}
            />
          );
        }
        return <EmptySlot key={`empty-${i}`} onClick={onClickEmpty} />;
      })}
    </div>
  );
}

function FilledSlot({
  soul,
  selected,
  applied,
  onClick,
  onReroll,
  onDelete,
  canReroll,
  onPreview,
}: {
  soul: SkillHubSoul;
  selected: boolean;
  applied: boolean;
  onClick: () => void;
  onReroll: () => void;
  onDelete: () => void;
  canReroll: boolean;
  onPreview: () => void;
}) {
  const t = useT();
  return (
    <div
      className="group relative transition-transform duration-200 hover:-translate-y-1"
      style={{
        // 选中态：黑色 2px 描边 + 强阴影（对齐 SkillHub）
        // 已注入但未选中：不加描边，仅靠左上角胶囊徽章标识
        boxShadow: selected
          ? "0 0 0 2px #000000, 0 20px 48px rgba(0,0,0,0.08)"
          : "none",
        borderRadius: 12,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-label={selected ? t("取消选中此人设") : t("选中此人设")}
        className="block w-full cursor-pointer"
      >
        <SoulFaceCard soul={soul} size="slot" onInterpret={onPreview} />
      </button>

      {/* 左上角：注入状态标签。appliedSlug 是单值，同一时间最多 1 张卡显示已注入。 */}
      {applied ? (
        <div
          className="pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            backgroundImage: "linear-gradient(135deg, #6B4FE0 0%, #F4B43A 100%)",
            color: "#ffffff",
            boxShadow: "0 4px 10px rgba(107,79,224,0.32)",
          }}
          title={t("已注入")}
          aria-label={t("当前已注入到 Agent")}
        >
          {t("已注入")}
        </div>
      ) : (
        <div
          className="group/unapplied absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs font-medium"
          style={{
            background: "rgba(255,255,255,0.86)",
            borderColor: "rgba(0,0,0,0.08)",
            color: "rgba(0,0,0,0.54)",
            boxShadow: "0 3px 10px rgba(0,0,0,0.06)",
          }}
          aria-label={t("当前未注入人设到 Agent")}
        >
          <UnappliedSoulIcon className="h-3.5 w-3.5" />
          <div className={UNAPPLIED_TOOLTIP_CLASS} role="tooltip">
            {t("未注入人设")}
            <span className={ACTION_TOOLTIP_ARROW_CLASS} aria-hidden />
          </div>
        </div>
      )}

      {/* 右上角：选中态显示「勾」（SkillHub 同款黑底白勾），未选中显示「删除 + 重抽」（hover 浮现） */}
      {selected ? (
        <div
          className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full"
          style={{
            background: "#000000",
            color: "#ffffff",
          }}
          aria-hidden
        >
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </div>
      ) : (
        <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (canReroll) onReroll();
            }}
            disabled={!canReroll}
            aria-label={t("重新抽取这张人设")}
            title={t("重新抽取")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "rgba(255,255,255,0.92)",
              color: "rgba(0,0,0,0.65)",
              border: "1px solid rgba(0,0,0,0.06)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
              backdropFilter: "blur(4px)",
            }}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={t("删除这张人设")}
            title={t("删除")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full"
            style={{
              background: "rgba(255,255,255,0.92)",
              color: "rgba(220,38,38,0.88)",
              border: "1px solid rgba(220,38,38,0.18)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
              backdropFilter: "blur(4px)",
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function EmptySlot({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    // group + group-hover 让卡片在 hover 时浮出顶部 tooltip 提示
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={t("点击空卡抽取人设")}
        className="block w-full cursor-pointer transition-transform duration-200 hover:-translate-y-1"
      >
        <CardBack iconClassName="h-9 w-9" />
      </button>
      {/* 悬浮提示：仅当 hover 时浮出，定位在卡片正中（浅色系） */}
      <div
        className="pointer-events-none absolute left-1/2 top-[35%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md px-3 py-1.5 text-[11px] font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={{
          background: "rgba(255,255,255,0.95)",
          color: "rgba(0,0,0,0.75)",
          border: "1px solid rgba(0,0,0,0.06)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          backdropFilter: "blur(4px)",
        }}
        role="tooltip"
      >
        {t("点击抽取人设")}
        {/* 底部居中三角箭头：双层 border 法实现 1px 浅边描边 */}
        <span
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: "100%",
            width: 0,
            height: 0,
            borderLeft: "6px solid transparent",
            borderRight: "6px solid transparent",
            borderTop: "6px solid rgba(0,0,0,0.06)",
          }}
          aria-hidden
        />
        <span
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: "100%",
            marginTop: -1,
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "5px solid rgba(255,255,255,0.95)",
          }}
          aria-hidden
        />
      </div>
    </div>
  );
}

// ─── 详情弹窗 ───────────────────────────────────────────────────────────────

function SoulPreviewModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const fetcher = useCallback(() => fetchSoulDetail(slug), [slug]);
  const { data, loading, error } = useAsyncResource(fetcher, [slug]);
  const spec = getSoulSpec(slug);
  return (
    <PreviewModal title={data?.displayName ?? ""} onClose={onClose}>
      {loading && <CenterLoader />}
      {error && <ErrorState message={error} onRetry={onClose} />}
      {data && (spec
        ? <SoulSpecPanel spec={spec} />
        : (
          <div>
            <p className="mb-4 text-sm" style={{ color: "rgba(0,0,0,0.65)" }}>
              {data.summary}
            </p>
            <SoulSpecRenderer content={data.content} />
          </div>
        )
      )}
    </PreviewModal>
  );
}

function PreviewModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  // 用 Portal 挂到 body，避开外层 framer-motion `filter: blur(...)`
  // 创建的 containing block —— 否则 fixed 会相对该祖先定位，导致弹窗被裁。
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white"
        style={PANEL_CARD_STYLE}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-3 px-6 py-4"
          style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}
        >
          <h4
            className="flex-1 truncate text-base font-semibold"
            style={{ color: "rgba(0,0,0,0.90)" }}
          >
            {title}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-black/55 transition-colors hover:bg-black/[0.05] hover:text-black/85"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ─── 通用状态组件 ───────────────────────────────────────────────────────────

function CenterLoader() {
  return (
    <div className="flex items-center justify-center py-12" style={{ color: "rgba(0,0,0,0.4)" }}>
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-sm" style={{ color: "rgba(0,0,0,0.55)" }}>
        {t("加载失败")}：{message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full px-4 py-1.5 text-xs font-medium transition-colors"
        style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.85)" }}
      >
        {t("重试")}
      </button>
    </div>
  );
}

// 未登录态：Vibebase 返回 401 时整面板替换为这个空状态。
// 不弹 toast、不嵌套在 grid 里，让用户视觉上一目了然"需要先登录"。
function UnauthorizedState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle
        className="h-6 w-6"
        style={{ color: "rgba(0,0,0,0.45)" }}
      />
      <p className="text-sm" style={{ color: "rgba(0,0,0,0.65)" }}>
        {t("登录后即可保存你的搭子人设")}
      </p>
      <p className="text-xs" style={{ color: "rgba(0,0,0,0.4)" }}>
        {t("AI 搭子状态会同步到你的账号，跨设备可见")}
      </p>
    </div>
  );
}

// ─── 删除确认弹窗 ─────────────────────────────────────────────────────────────
// 视觉对齐 `openclaw-settings-page.tsx` 的 `_DeleteConfirmDialog`：
//   - 半透明遮罩 + 8px 模糊
//   - 圆角白色卡片 + AlertTriangle 红色图标 + 标题 + 说明 + 取消/确认按钮
// 通过 `createPortal` 挂到 document.body，避免 panel 内嵌套定位影响
//
// onConfirm / onCancel 由调用方控制；本组件不持有状态，仅展示 + 转发事件。

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
        style={{
          background: "rgba(255,255,255,0.98)",
          borderColor: "rgba(0,0,0,0.06)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ background: "rgba(207,61,76,0.08)" }}
        >
          <AlertTriangle className="h-6 w-6" style={{ color: "#cf3d4c" }} />
        </div>
        <h3 className="mb-1.5 text-lg font-bold" style={{ color: "rgba(0,0,0,0.92)" }}>
          {title}
        </h3>
        <p
          className="mb-6 text-center text-sm leading-relaxed"
          style={{ color: "rgba(0,0,0,0.65)" }}
        >
          {message}
        </p>
        <div className="flex w-full gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full border px-4 py-2.5 font-medium transition-colors hover:bg-[rgba(0,0,0,0.04)]"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666", fontSize: "16px" }}
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-full px-4 py-2.5 font-bold text-white transition-colors hover:opacity-90"
            style={{ background: "#cf3d4c", fontSize: "16px" }}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

// ─── 信息对话框 ──────────────────────────────────────────────────────────────
// 视觉对齐 ConfirmDialog，但单按钮 + 蓝色 Info 图标，用于"成功 + 后续指引"场景。
// onClose 由调用方控制；点遮罩或确认按钮都触发 onClose。

function InfoDialog({
  title,
  message,
  buttonLabel,
  onClose,
}: {
  title: string;
  message: string;
  buttonLabel: string;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col rounded-[1.5rem] border p-6 shadow-2xl"
        style={{
          background: "rgba(255,255,255,0.98)",
          borderColor: "rgba(0,0,0,0.06)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          className="mb-2.5 inline-flex items-center gap-1.5 text-base font-semibold"
          style={{ color: "rgba(0,0,0,0.92)" }}
        >
          <Check className="h-4 w-4" style={{ color: "rgba(0,0,0,0.55)" }} aria-hidden />
          {title}
        </h3>
        <p
          className="text-left text-[13px] leading-relaxed"
          style={{ color: "rgba(0,0,0,0.55)", paddingTop: 10, paddingBottom: 10 }}
        >
          {/* 把 message 里的 /new 高亮成红色加粗，便于用户一眼识别要输入的命令 */}
          {message.split(/(\/new)/g).map((part, i) =>
            part === "/new" ? (
              <strong key={i} style={{ color: "#cf3d4c", fontWeight: 600 }}>{part}</strong>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </p>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-5 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
            style={{ background: "rgba(0,0,0,0.90)" }}
          >
            {buttonLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
