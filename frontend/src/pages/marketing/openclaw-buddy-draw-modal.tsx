/**
 * AI 搭子抽卡弹窗
 *
 * 视觉参考 SkillHub `/hermes` 的 DrawModal：6 张卡牌背面（3×2 网格）→ 跑灯
 * 高亮在 6 张卡之间走马灯 → 抽中卡片 3D 翻牌放大 → 结果展示 → "使用此人设"。
 *
 * 翻牌后正面与 reveal 阶段都使用 `@/lib/soul-visuals` 里镜像的 SkillHub 卡面图（bgUrl）+
 * 主题渐变色（color），实现与 SkillHub 原版一致的视觉体验。
 *
 * 数据策略：从 props 传入的 souls 池里 Math.random 一张作为抽卡结果。
 * **不调 SkillHub 的 /activity/.../souls/draw 接口** —— 该接口需要鉴权，
 * 等"mono2 后端代理 + service token"方案落地后再换成真接口。
 */

import { motion, AnimatePresence } from "framer-motion";
import { Eye, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/i18n/t";
import { fetchSoulDetail, type SkillHubSoul } from "@/lib/skillhub-api";
import { useAsyncResource } from "@/services/use-async-resource";
import {
  REVEAL_STAR_BG,
  getSoulColor,
} from "@/lib/soul-visuals";
import {
  CardBack,
  SoulFaceCard,
  SoulSpecRenderer,
} from "@/pages/marketing/openclaw-buddy-cards";

/** 跑灯顺序：左→右、上→下，蛇形闭合避免抖动 */
const CYCLE_ORDER = [0, 1, 2, 5, 4, 3];

const SPEED_MS = 130;
const MIN_CYCLES = 2; // 跑灯至少跑满圈数后才能停在赢家位置

/** 弹窗阶段 */
type Phase = "idle" | "cycling" | "flipping" | "revealed";

interface DrawSoulModalProps {
  open: boolean;
  /** 抽卡候选池（即从 fetchSouls 拿到的列表） */
  souls: SkillHubSoul[];
  /** 已抽到过的 slug 集合，会从抽卡池里剔除，避免重复抽到同一张人设 */
  drawnSlugs?: string[];
  onClose: () => void;
  /** 抽中并点击 "使用此人设" 时回调 */
  onPick: (soul: SkillHubSoul) => void;
}

export function DrawSoulModal({ open, souls, drawnSlugs, onClose, onPick }: DrawSoulModalProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("idle");
  /** 跑灯当前高亮卡片索引（0-5） */
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  /** 抽中的卡片索引（0-5），决定停灯位置 */
  const [winnerIdx, setWinnerIdx] = useState<number>(0);
  /** 抽中的 Soul */
  const [winnerSoul, setWinnerSoul] = useState<SkillHubSoul | null>(null);

  const stepRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 弹窗打开时复位 */
  useEffect(() => {
    if (!open) {
      setPhase("idle");
      setActiveIdx(-1);
      setWinnerSoul(null);
      stepRef.current = 0;
      if (tickerRef.current) {
        clearTimeout(tickerRef.current);
        tickerRef.current = null;
      }
    }
  }, [open]);

  /** 跑灯定时器：cycling 阶段周期性切换 activeIdx，跑满 MIN_CYCLES 圈停在 winnerIdx */
  useEffect(() => {
    if (phase !== "cycling") return;
    const tick = () => {
      stepRef.current += 1;
      const cyclePos = stepRef.current % CYCLE_ORDER.length;
      const nextIdx = CYCLE_ORDER[cyclePos]!;
      setActiveIdx(nextIdx);
      // 跑满最少圈数 + 停在 winnerIdx → 进入翻牌阶段
      if (
        stepRef.current >= CYCLE_ORDER.length * MIN_CYCLES &&
        nextIdx === winnerIdx
      ) {
        // 留 200ms 让用户看清"停在哪张"，再翻牌
        tickerRef.current = setTimeout(() => setPhase("flipping"), 200);
        return;
      }
      tickerRef.current = setTimeout(tick, SPEED_MS);
    };
    tickerRef.current = setTimeout(tick, SPEED_MS);
    return () => {
      if (tickerRef.current) {
        clearTimeout(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [phase, winnerIdx]);

  /** 翻牌完成 → 展示结果 */
  const handleFlipDone = useCallback(() => {
    setPhase("revealed");
  }, []);

  /** 抽卡池：剔除已抽到的 slug，避免重复抽到同一张 */
  const drawablePool = useMemo(() => {
    if (!drawnSlugs || drawnSlugs.length === 0) return souls;
    const drawn = new Set(drawnSlugs);
    return souls.filter((s) => !drawn.has(s.slug));
  }, [souls, drawnSlugs]);

  const handleStart = useCallback(() => {
    if (drawablePool.length === 0) return;
    const soul = drawablePool[Math.floor(Math.random() * drawablePool.length)]!;
    setWinnerSoul(soul);
    setWinnerIdx(Math.floor(Math.random() * 6));
    stepRef.current = 0;
    setPhase("cycling");
  }, [drawablePool]);

  const handleConfirm = useCallback(() => {
    if (winnerSoul) onPick(winnerSoul);
  }, [onPick, winnerSoul]);

  if (!open) return null;

  const isRevealed = phase === "revealed" && winnerSoul !== null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      {/* 弹窗主体：reveal 阶段切换为 soul.color 全屏渐变背景 */}
      <motion.div
        className="relative w-full max-w-[412px] overflow-hidden rounded-2xl"
        animate={{
          background: isRevealed && winnerSoul
            ? getSoulColor(winnerSoul)
            : "#ffffff",
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        <CloseButton onClick={onClose} variant={isRevealed ? "light" : "default"} />

        <AnimatePresence mode="wait">
          {!isRevealed ? (
            <motion.div
              key="drawing"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="relative flex flex-col items-center gap-6 px-6 py-9"
              style={{ perspective: 800 }}
            >
              <h3
                className="text-lg font-semibold"
                style={{ color: "rgba(0,0,0,0.90)" }}
              >
                {phase === "flipping"
                  ? t("翻牌中…")
                  : t("抽取你的 AI 人设")}
              </h3>

              {/* 6 张卡牌 3×2 网格 */}
              <div className="grid grid-cols-3 gap-3" style={{ width: 360 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <CardBack key={i} active={activeIdx === i} />
                ))}
              </div>

              {phase === "idle" && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={drawablePool.length === 0}
                  className="rounded-full px-8 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
                >
                  {souls.length === 0
                    ? t("加载中…")
                    : drawablePool.length === 0
                      ? t("已抽完所有人设")
                      : t("开始抽卡")}
                </button>
              )}
              {phase === "cycling" && (
                <p className="text-sm" style={{ color: "rgba(0,0,0,0.55)" }}>
                  {t("正在抽取…")}
                </p>
              )}

              {/* 翻牌动画：在 6 张卡上叠一层放大翻转的中奖卡 */}
              {phase === "flipping" && winnerSoul && (
                <FlipReveal soul={winnerSoul} onDone={handleFlipDone} />
              )}
            </motion.div>
          ) : (
            <RevealPanel
              soul={winnerSoul!}
              onConfirm={handleConfirm}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

// ─── 关闭按钮 ───────────────────────────────────────────────────────────────

function CloseButton({
  onClick,
  variant = "default",
}: {
  onClick: () => void;
  variant?: "default" | "light";
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("关闭")}
      className="absolute right-4 top-4 z-20 transition-opacity hover:opacity-60"
      style={{
        color: variant === "light" ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.55)",
      }}
    >
      <X className="h-5 w-5" />
    </button>
  );
}

// ─── 翻牌动画 ───────────────────────────────────────────────────────────────

function FlipReveal({ soul, onDone }: { soul: SkillHubSoul; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <motion.div
      key="flip"
      initial={{ rotateY: 0, scale: 1 }}
      animate={{ rotateY: 180, scale: 1.2 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.0, ease: "easeOut" }}
      className="absolute inset-0 z-10 flex items-center justify-center"
      style={{ perspective: 800, pointerEvents: "none", transformStyle: "preserve-3d" }}
    >
      <div
        className="relative aspect-[112/157] w-[156px]"
        style={{ transformStyle: "preserve-3d" }}
      >
        <div
          className="absolute inset-0"
          style={{ backfaceVisibility: "hidden" }}
        >
          <CardBack active />
        </div>
        <div
          className="absolute inset-0"
          style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
        >
          <SoulFaceCard soul={soul} size="small" />
        </div>
      </div>
    </motion.div>
  );
}

// ─── 抽中后 reveal 全屏面板 ──────────────────────────────────────────────────

function RevealPanel({
  soul,
  onConfirm,
}: {
  soul: SkillHubSoul;
  onConfirm: () => void;
}) {
  const t = useT();
  const [interpretOpen, setInterpretOpen] = useState(false);
  return (
    <motion.div
      key="revealed"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="relative px-9 pb-8 pt-9"
    >
      {/* 顶部星点装饰，覆盖在彩色背景之上、内容之下 */}
      <img
        src={REVEAL_STAR_BG}
        alt=""
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[296px] w-full object-cover"
        draggable={false}
      />

      <div className="relative z-10 flex flex-col items-center gap-7">
        {/* 标题：固定文案 + 名字片段拼接，让 i18n 提取走"恭喜获得"这一条 key */}
        <h2 className="text-center font-heading text-[22px] font-semibold leading-[1.36em] text-white">
          {t("恭喜获得")}「{soul.displayName}」！
        </h2>

        {/* 大版人设卡 */}
        <SoulFaceCard
          soul={soul}
          size="large"
          onInterpret={() => setInterpretOpen(true)}
        />

        <div className="mt-3 w-full">
          <button
            type="button"
            onClick={onConfirm}
            className="h-14 w-full rounded-full text-base font-semibold transition-colors hover:bg-black"
            style={{ background: "#202020", color: "#ffffff", boxShadow: "0 14px 28px rgba(0,0,0,0.10)" }}
          >
            {t("使用此人设")}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {interpretOpen && (
          <SoulInterpretModal soul={soul} onClose={() => setInterpretOpen(false)} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function SoulInterpretModal({ soul, onClose }: { soul: SkillHubSoul; onClose: () => void }) {
  const t = useT();
  const fetcher = useCallback(() => fetchSoulDetail(soul.slug), [soul.slug]);
  const { data, loading, error } = useAsyncResource(fetcher, [soul.slug]);

  return (
    <motion.div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 px-5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="max-h-[76vh] w-full overflow-hidden rounded-2xl bg-white"
        initial={{ y: 18, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 12, scale: 0.98 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-black/10 px-5 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Eye className="h-4 w-4 text-black/70" />
            <h3 className="truncate text-base font-semibold text-black/90">
              {t("人设解读")} · {soul.displayName}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭")}
            className="text-black/55 transition-opacity hover:opacity-70"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-black/40">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {error && (
            <p className="py-8 text-center text-sm text-black/55">{error}</p>
          )}
          {data && (
            <div>
              <p className="mb-4 text-sm leading-7 text-black/65">{data.summary}</p>
              <SoulSpecRenderer content={data.content} />
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
