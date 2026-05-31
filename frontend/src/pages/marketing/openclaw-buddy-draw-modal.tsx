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
import { createPortal } from "react-dom";
import { useT } from "@/i18n/t";
import { fetchSoulDetail, type SkillHubSoul } from "@/lib/skillhub-api";
import { getSoulSpec } from "@/lib/soul-interpretations";
import { SoulSpecPanel } from "@/components/soul-spec-panel";
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

/** 卡牌尺寸（小卡）+ 翻牌放大比例（对齐 SkillHub）*/
const CARD_W = 112;
const CARD_H = 157.54;
const FLIP_SCALE = 1.4;

/** 3×2 网格容器尺寸（含 gap） */
const GRID_W = 360;
const GRID_GAP = 12;
const GRID_H = CARD_H * 2 + GRID_GAP;

/** 6 张卡的绝对坐标（左上角原点）*/
const CARD_POSITIONS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: CARD_W + GRID_GAP, y: 0 },
  { x: (CARD_W + GRID_GAP) * 2, y: 0 },
  { x: 0, y: CARD_H + GRID_GAP },
  { x: CARD_W + GRID_GAP, y: CARD_H + GRID_GAP },
  { x: (CARD_W + GRID_GAP) * 2, y: CARD_H + GRID_GAP },
];

/** 翻牌时中奖卡飞到的中心位置（左上角坐标）*/
const CENTER_X = (GRID_W - CARD_W * FLIP_SCALE) / 2;
const CENTER_Y = (GRID_H - CARD_H * FLIP_SCALE) / 2;

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
        tickerRef.current = setTimeout(() => setPhase("flipping"), 600);
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

  /** flipping 阶段时序（对齐 SkillHub）：
   * - 0~300ms 非中奖卡 fade out
   * - 300~700ms 中奖卡移动 + 放大
   * - 700~1200ms Y 轴 3D 翻转
   * - 1200~1700ms 停顿，再切到 revealed 全屏 */
  useEffect(() => {
    if (phase !== "flipping") return;
    const t = setTimeout(() => setPhase("revealed"), 1700);
    return () => clearTimeout(t);
  }, [phase]);

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
                className="relative z-20 text-lg font-semibold"
                style={{ color: "rgba(0,0,0,0.90)" }}
              >
                {phase === "flipping"
                  ? t("翻牌中…")
                  : t("玄学开启！寻找独特灵魂…")}
              </h3>

              {/* 6 张卡牌 3×2 网格（绝对坐标，方便中奖卡 framer-motion 移动到中心 + 放大 + 翻转） */}
              <div
                className="relative"
                style={{ width: GRID_W, height: GRID_H }}
              >
                {CARD_POSITIONS.map((pos, i) => (
                  <DrawCard
                    key={i}
                    x={pos.x}
                    y={pos.y}
                    isActive={activeIdx === i}
                    isWinner={i === winnerIdx}
                    phase={phase}
                    soul={winnerSoul ?? null}
                    onStart={phase === "idle" && drawablePool.length > 0 ? handleStart : undefined}
                  />
                ))}
              </div>

              {phase === "idle" && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={drawablePool.length === 0}
                  className="rounded-full px-8 py-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: "rgba(0,0,0,0.90)",
                    color: "#ffffff",
                    fontSize: "16px",
                    lineHeight: "1.35",
                  }}
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

// ─── 卡牌渲染（cycling / flipping）───────────────────────────────────────────

/** 6 张卡之一：默认 CardBack；flipping 阶段非中奖卡淡出，中奖卡飞到中心 + 放大 + Y 轴 3D 翻转。
 *  idle 阶段且传入 onStart 时，卡片本身可点击触发抽卡（小手 cursor）。 */
function DrawCard({
  x,
  y,
  isActive,
  isWinner,
  phase,
  soul,
  onStart,
}: {
  x: number;
  y: number;
  isActive: boolean;
  isWinner: boolean;
  phase: Phase;
  soul: SkillHubSoul | null;
  onStart?: () => void;
}) {
  const isFlipping = phase === "flipping";
  const isRevealed = phase === "revealed";

  // 非中奖卡在翻牌阶段淡出消失
  if ((isFlipping || isRevealed) && !isWinner) {
    return (
      <motion.div
        className="absolute"
        initial={{ opacity: 1, scale: 1 }}
        animate={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.3, ease: "easeIn" }}
        style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
      >
        <CardBack />
      </motion.div>
    );
  }

  // 中奖卡：移动到中心 + 放大 + Y 轴翻转
  if (isFlipping && isWinner) {
    return (
      <motion.div
        className="absolute z-10"
        initial={{ left: x, top: y, width: CARD_W, height: CARD_H }}
        animate={{
          left: CENTER_X,
          top: CENTER_Y,
          width: CARD_W * FLIP_SCALE,
          height: CARD_H * FLIP_SCALE,
        }}
        transition={{ duration: 0.4, delay: 0.3, ease: "easeInOut" }}
        style={{ transformStyle: "preserve-3d" }}
      >
        <FlipCard isActive soul={soul} />
      </motion.div>
    );
  }

  // 默认（idle / cycling / error）
  // idle 阶段：button + cursor-pointer + hover 微抬，可点击触发抽卡
  // cycling：恢复成普通 div，避免 Active spotlight 时点击重抽
  if (phase === "idle" && onStart) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="absolute cursor-pointer transition-transform duration-200 hover:-translate-y-1"
        style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
      >
        <CardBack active={isActive} />
      </button>
    );
  }
  return (
    <div
      className="absolute"
      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
    >
      <CardBack active={isActive} />
    </div>
  );
}

/** 翻牌：Y 轴 180° 旋转，背→正 */
function FlipCard({ isActive, soul }: { isActive: boolean; soul: SkillHubSoul | null }) {
  return (
    <motion.div
      className="relative h-full w-full"
      initial={{ rotateY: 0 }}
      animate={{ rotateY: 180 }}
      transition={{ duration: 0.5, delay: 0.7, ease: "easeInOut" }}
      style={{ transformStyle: "preserve-3d" }}
    >
      {/* 背面 */}
      <div
        className="absolute inset-0"
        style={{ backfaceVisibility: "hidden" }}
      >
        <CardBack active={isActive} />
      </div>
      {/* 正面（旋转后可见）*/}
      <div
        className="absolute inset-0"
        style={{
          backfaceVisibility: "hidden",
          transform: "rotateY(180deg)",
        }}
      >
        {soul ? <SoulFaceCard soul={soul} size="small" /> : <CardBack />}
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

        <div className="mt-3 flex w-full justify-center">
          <button
            type="button"
            onClick={onConfirm}
            className="h-12 w-full max-w-[336px] rounded-full font-semibold transition-colors hover:bg-black"
            style={{
              background: "#202020",
              color: "#ffffff",
              boxShadow: "0 14px 28px rgba(0,0,0,0.10)",
              fontSize: "16px",
            }}
          >
            {t("添加此人设")}
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

  // 用 Portal 挂到 body，避开 reveal panel 的 padding/高度裁切，
  // 同时 fixed 相对视口居中，不被祖先 transform/filter 影响。
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 py-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        initial={{ y: 18, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 12, scale: 0.98 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-black/10 px-6 py-4">
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
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center py-12 text-black/40">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {error && (
            <p className="py-8 text-center text-sm text-black/55">{error}</p>
          )}
          {data && (() => {
            // 优先使用本地 SkillHub 同款"人设解读 + 5 维度"；缺失时回退到 OpenSpec
            const spec = getSoulSpec(soul.slug);
            if (spec) {
              return <SoulSpecPanel spec={spec} />;
            }
            return (
              <div>
                <p className="mb-4 text-sm leading-7 text-black/65">{data.summary}</p>
                <SoulSpecRenderer content={data.content} />
              </div>
            );
          })()}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
