/**
 * AI 搭子抽卡弹窗
 *
 * 视觉参考 SkillHub `/hermes` 的 DrawModal：6 张卡牌背面（3×2 网格）→ 跑灯
 * 高亮在 6 张卡之间走马灯 → 抽中卡片 3D 翻牌放大 → 结果展示 → "使用此人设"。
 *
 * 数据策略：从 props 传入的 souls 池里 Math.random 一张作为抽卡结果。
 * **不调 SkillHub 的 /activity/.../souls/draw 接口** —— 该接口需要鉴权，
 * 等"mono2 后端代理 + service token"方案落地后再换成真接口。
 */

import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/t";
import type { SkillHubSoul } from "@/lib/skillhub-api";

/** 卡背纹理（来自 SkillHub COS，公开图片资源） */
const CARD_BACK_IMG =
  "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/86be223d-cfc5-41bf-9950-e7d5b1353e13.png";

/** 拼图图标（来自 SkillHub COS） */
const PUZZLE_ICON =
  "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/d224cdb8-a36f-43ef-8da7-99ba79ef5cba.png";

/** 彩虹渐变高亮边框（来自 SkillHub） */
const RAINBOW_GRADIENT =
  "linear-gradient(224deg, #1446FF 0%, #249CFF 25%, #7AF1FF 51%, #FFD900 74%, #FF966D 100%)";

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
  onClose: () => void;
  /** 抽中并点击 "使用此人设" 时回调 */
  onPick: (soul: SkillHubSoul) => void;
}

export function DrawSoulModal({ open, souls, onClose, onPick }: DrawSoulModalProps) {
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

  const handleStart = useCallback(() => {
    if (souls.length === 0) return;
    const soul = souls[Math.floor(Math.random() * souls.length)]!;
    setWinnerSoul(soul);
    setWinnerIdx(Math.floor(Math.random() * 6));
    stepRef.current = 0;
    setPhase("cycling");
  }, [souls]);

  const handleConfirm = useCallback(() => {
    if (winnerSoul) onPick(winnerSoul);
  }, [onPick, winnerSoul]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-[460px] flex-col items-center gap-6 rounded-2xl bg-white px-6 py-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("关闭")}
          className="absolute right-4 top-4 transition-opacity hover:opacity-60"
          style={{ color: "rgba(0,0,0,0.55)" }}
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-semibold" style={{ color: "rgba(0,0,0,0.90)" }}>
          {phase === "revealed" ? t("抽卡结果") : t("抽取你的 AI 人设")}
        </h3>

        {phase !== "revealed" ? (
          <>
            {/* 6 张卡牌 3×2 网格 */}
            <div className="grid grid-cols-3 gap-3" style={{ width: 360 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <CardBack key={i} active={activeIdx === i} />
              ))}
            </div>

            {phase === "idle" ? (
              <button
                type="button"
                onClick={handleStart}
                disabled={souls.length === 0}
                className="rounded-full px-8 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
              >
                {souls.length === 0 ? t("加载中…") : t("开始抽卡")}
              </button>
            ) : (
              <p className="text-sm" style={{ color: "rgba(0,0,0,0.55)" }}>
                {t("正在抽取…")}
              </p>
            )}
          </>
        ) : null}

        <AnimatePresence>
          {phase === "flipping" && winnerSoul && (
            <FlipReveal soul={winnerSoul} onDone={handleFlipDone} />
          )}
          {phase === "revealed" && winnerSoul && (
            <RevealResult soul={winnerSoul} onConfirm={handleConfirm} onRedraw={handleStart} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── 卡牌背面 ───────────────────────────────────────────────────────────────

function CardBack({ active }: { active: boolean }) {
  return (
    <div
      className="relative aspect-[112/157] w-full overflow-hidden rounded transition-shadow duration-200"
      style={{
        background: active ? RAINBOW_GRADIENT : "#E9E9E9",
        padding: active ? 2 : 0.6,
        boxShadow: active ? "0 32px 54px rgba(0,0,0,0.05)" : "none",
      }}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[3px] bg-white">
        <img
          src={CARD_BACK_IMG}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <img
          src={PUZZLE_ICON}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2"
        />
        <div
          className="pointer-events-none absolute rounded-[3px] border"
          style={{
            inset: 2.5,
            borderColor: "rgba(0,0,0,0.08)",
            borderWidth: 0.6,
          }}
        />
      </div>
    </div>
  );
}

// ─── 翻牌动画（短暂占位，1.2s 后通知 done） ─────────────────────────────────

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
      className="absolute inset-0 flex items-center justify-center"
      style={{ perspective: 800, pointerEvents: "none" }}
    >
      <SoulFaceCard soul={soul} />
    </motion.div>
  );
}

// ─── 抽卡结果展示 ───────────────────────────────────────────────────────────

function RevealResult({
  soul,
  onConfirm,
  onRedraw,
}: {
  soul: SkillHubSoul;
  onConfirm: () => void;
  onRedraw: () => void;
}) {
  const t = useT();
  return (
    <motion.div
      key="reveal"
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center gap-5"
    >
      <SoulFaceCard soul={soul} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRedraw}
          className="rounded-full px-5 py-2 text-sm font-medium transition-colors"
          style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.85)" }}
        >
          {t("再抽一次")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-full px-6 py-2 text-sm font-medium transition-colors"
          style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
        >
          {t("使用此人设")}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Soul 正面卡片 ──────────────────────────────────────────────────────────

/**
 * Soul 正面卡片 —— SkillHub 的版本依赖各 soul hardcoded 的 avatar / bgUrl /
 * color 资源（在他们前端 constants/souls.ts 里），公共 API 没暴露这些字段。
 * 这里基于 slug 派生一个伪随机渐变色，作为视觉差异化。
 */
function SoulFaceCard({ soul }: { soul: SkillHubSoul }) {
  const gradient = gradientFromSlug(soul.slug);
  return (
    <div
      className="flex aspect-[3/4] w-[180px] flex-col items-center justify-center gap-2 rounded-[8px] px-3 py-4 text-center"
      style={{
        background: gradient,
        color: "rgba(0,0,0,0.85)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.10)",
      }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full text-base font-semibold"
        style={{ background: "rgba(255,255,255,0.55)", color: "rgba(0,0,0,0.85)" }}
      >
        {soul.slug.slice(0, 2).toUpperCase()}
      </div>
      <div className="text-sm font-semibold">{soul.displayName}</div>
      <div className="line-clamp-3 text-[11px] leading-snug" style={{ color: "rgba(0,0,0,0.65)" }}>
        {soul.summary}
      </div>
    </div>
  );
}

/** 由 slug 派生稳定的卡面渐变色，让同名人设每次抽出来颜色一致 */
function gradientFromSlug(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  const hue1 = hash % 360;
  const hue2 = (hue1 + 40) % 360;
  return `linear-gradient(160deg, hsl(${hue1}deg 75% 88%) 0%, hsl(${hue2}deg 70% 92%) 100%)`;
}
