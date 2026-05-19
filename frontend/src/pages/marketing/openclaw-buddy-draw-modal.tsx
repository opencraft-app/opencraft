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
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/t";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import {
  REVEAL_STAR_BG,
  getSoulColor,
  getSoulVisuals,
} from "@/lib/soul-visuals";

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
                  disabled={souls.length === 0}
                  className="rounded-full px-8 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
                >
                  {souls.length === 0 ? t("加载中…") : t("开始抽卡")}
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
              onRedraw={handleStart}
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
      style={{ perspective: 800, pointerEvents: "none" }}
    >
      <SoulFaceCard soul={soul} size="small" />
    </motion.div>
  );
}

// ─── 抽中后 reveal 全屏面板 ──────────────────────────────────────────────────

function RevealPanel({
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

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* 标题：固定文案 + 名字片段拼接，让 i18n 提取走"恭喜获得"这一条 key */}
        <h2 className="text-center font-heading text-[22px] font-semibold leading-[1.36em] text-white">
          {t("恭喜获得")}「{soul.displayName}」！
        </h2>

        {/* 大版人设卡 */}
        <SoulFaceCard soul={soul} size="large" />

        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={onRedraw}
            className="rounded-full px-5 py-2 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.4)",
            }}
          >
            {t("再抽一次")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full px-6 py-2 text-sm font-semibold transition-colors hover:bg-black"
            style={{ background: "#202020", color: "#ffffff" }}
          >
            {t("使用此人设")}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Soul 正面卡片 ──────────────────────────────────────────────────────────

/**
 * 翻牌后展示的人设卡 —— 用 `bgUrl` 作整张卡背景图（每张 soul 自带的全身像 +
 * 渐变背景），底部叠 `displayName` + `summary`。视觉直接对齐 SkillHub
 * `SoulCardFace` 在 `useBgUrl=true` 模式下的渲染。
 */
function SoulFaceCard({
  soul,
  size,
}: {
  soul: SkillHubSoul;
  size: "small" | "large";
}) {
  const visuals = getSoulVisuals(soul);
  const isLarge = size === "large";
  return (
    <div
      className="relative overflow-hidden rounded-[10px]"
      style={{
        width: isLarge ? 240 : 156,
        aspectRatio: isLarge ? "240 / 338" : "112 / 157",
        background: visuals.bgUrl
          ? `url(${visuals.bgUrl}) center/cover no-repeat`
          : "#f0f0f0",
        border: isLarge ? "4px solid #fff" : "2px solid #fff",
        boxShadow: isLarge
          ? "0 26px 63px rgba(0,0,0,0.08)"
          : "0 12px 32px rgba(0,0,0,0.10)",
      }}
    >
      {/* 底部信息浮层 */}
      <div className="absolute inset-x-3 bottom-3 flex flex-col gap-1">
        <div
          className={`font-heading font-semibold text-black ${
            isLarge ? "text-[20px] leading-[1.4em]" : "text-[15px] leading-[1.4em]"
          }`}
        >
          {soul.displayName}
        </div>
        <p
          className={`line-clamp-2 text-left leading-[1.5em] ${
            isLarge ? "text-[13px]" : "text-[11px]"
          }`}
          style={{ color: "rgba(0,0,0,0.7)" }}
        >
          {soul.summary}
        </p>
      </div>
    </div>
  );
}
