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
 * 数据来源：`@/lib/skillhub-api`，跨域直连 https://api.skillhub.cn 的
 * 公共接口（lightclaw.tech 已在其 CORS 白名单内）。
 *
 * 注：AI 搭子当前仅保留 Soul（人设）浏览与抽卡能力。
 */

import { ExternalLink, Loader2, Sparkles, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { useT } from "@/i18n/t";
import { useAsyncResource } from "@/services/use-async-resource";
import { DrawSoulModal } from "@/pages/marketing/openclaw-buddy-draw-modal";
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

const PANEL_CARD_STYLE: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.06)",
  background: "#ffffff",
  boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
};

/** 抽卡槽位数上限（6 列 × 1 行 = 6 张，单行展示） */
const MAX_DRAWS = 6;

export function BuddyPanel() {
  const t = useT();
  const [previewSoulSlug, setPreviewSoulSlug] = useState<string | null>(null);
  /** 已抽到的人设，按抽到顺序排列，去重 by slug，最多 MAX_DRAWS 张 */
  const [drawnSouls, setDrawnSouls] = useState<SkillHubSoul[]>([]);
  /** 抽卡弹窗开关 */
  const [drawOpen, setDrawOpen] = useState(false);

  // souls 列表是抽卡 modal 的候选池数据源 —— 提到这一层统一拉取，
  // 避免 SoulSlotGrid 内部 fetch 一次、DrawModal 再单独 fetch 一次。
  const soulsFetcher = useCallback(() => fetchSouls({ page: 1, pageSize: 30 }), []);
  const soulsResource = useAsyncResource(soulsFetcher, []);
  const souls = soulsResource.data?.souls ?? [];

  const drawnSlugs = drawnSouls.map((s) => s.slug);
  const isAtMax = drawnSouls.length >= MAX_DRAWS;

  const handlePickFromDraw = useCallback((soul: SkillHubSoul) => {
    setDrawnSouls((prev) => {
      if (prev.some((s) => s.slug === soul.slug)) return prev; // dedupe（防御）
      if (prev.length >= MAX_DRAWS) return prev; // 上限保护
      return [...prev, soul];
    });
    setDrawOpen(false);
  }, []);

  const handleOpenDraw = useCallback(() => {
    if (isAtMax) return;
    setDrawOpen(true);
  }, [isAtMax]);

  return (
    <div className="overflow-hidden rounded-2xl" style={PANEL_CARD_STYLE}>
      {/* 头部：标题 + 进度 + 抽卡按钮 + 跳转 SkillHub */}
      <div
        className="flex flex-wrap items-center gap-3 px-6 py-4"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.90)" }}
        >
          <Users className="h-4 w-4" />
        </div>
        <h3
          className="text-base font-semibold"
          style={{ color: "rgba(0,0,0,0.90)", letterSpacing: "-0.2px" }}
        >
          {t("AI 搭子")}
        </h3>

        {drawnSouls.length > 0 && <ProgressChip drawn={drawnSouls.length} max={MAX_DRAWS} />}

        <div className="ml-auto flex items-center gap-3">
          <a
            href="https://skillhub.cn/hermes"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
            style={{ color: "rgba(0,0,0,0.60)" }}
          >
            {t("前往 SkillHub 体验完整版")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {/* 主 CTA：抽取人设 —— 显眼居中，作为页面主要动作入口 */}
      <div className="flex justify-center pt-6 pb-4">
        <button
          type="button"
          onClick={handleOpenDraw}
          disabled={souls.length === 0 || isAtMax}
          className="inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold transition-all hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none"
          style={{
            background: "rgba(0,0,0,0.90)",
            color: "#ffffff",
            boxShadow: "0 6px 16px rgba(0,0,0,0.10)",
          }}
        >
          <Sparkles className="h-4 w-4" />
          {isAtMax ? t("已抽满 6 张") : t("抽取人设")}
        </button>
      </div>

      {/* 内容区：6 格抽卡槽 */}
      <div className="px-6 pb-6">
        <SoulSlotGrid
          drawnSouls={drawnSouls}
          loading={soulsResource.loading && souls.length === 0}
          error={souls.length === 0 ? soulsResource.error : null}
          onReload={soulsResource.reload}
          onClickFilled={(slug) => setPreviewSoulSlug(slug)}
          onClickEmpty={handleOpenDraw}
        />
      </div>

      <DrawSoulModal
        open={drawOpen}
        souls={souls}
        drawnSlugs={drawnSlugs}
        onClose={() => setDrawOpen(false)}
        onPick={handlePickFromDraw}
      />

      {previewSoulSlug && (
        <SoulPreviewModal slug={previewSoulSlug} onClose={() => setPreviewSoulSlug(null)} />
      )}
    </div>
  );
}

// ─── 进度 chip ──────────────────────────────────────────────────────────────

function ProgressChip({ drawn, max }: { drawn: number; max: number }) {
  const t = useT();
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
      style={{ background: "rgba(255,122,69,0.10)", color: "#A85020" }}
    >
      <span style={{ color: "rgba(0,0,0,0.50)" }}>{t("已抽")}</span>
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
}: {
  drawnSouls: SkillHubSoul[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClickFilled: (slug: string) => void;
  onClickEmpty: () => void;
}) {
  if (loading) return <CenterLoader />;
  if (error) return <ErrorState message={error} onRetry={onReload} />;
  return (
    // 网格 max-w 锁在 920px 居中，6 列下单卡 ≈ 143×202，单行展示 6 张抽卡槽。
    // 容器在更窄视口里会自然缩小，cell 跟着变小。
    <div className="mx-auto grid max-w-[920px] grid-cols-6 gap-3">
      {Array.from({ length: MAX_DRAWS }).map((_, i) => {
        const soul = drawnSouls[i];
        if (soul) {
          return (
            <FilledSlot
              key={soul.slug}
              soul={soul}
              onClick={() => onClickFilled(soul.slug)}
            />
          );
        }
        return <EmptySlot key={`empty-${i}`} onClick={onClickEmpty} />;
      })}
    </div>
  );
}

function FilledSlot({ soul, onClick }: { soul: SkillHubSoul; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full transition-transform duration-200 hover:-translate-y-1"
    >
      <SoulFaceCard soul={soul} size="slot" />
    </button>
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
      {/* 悬浮提示：仅当 hover 时浮出，定位在卡片正上方 */}
      <div
        className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-3 py-1.5 text-[11px] font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={{
          background: "rgba(0,0,0,0.85)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        }}
        role="tooltip"
      >
        {t("为你的 Agent 伙伴解锁独特灵魂")}
      </div>
    </div>
  );
}

// ─── 详情弹窗 ───────────────────────────────────────────────────────────────

function SoulPreviewModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const fetcher = useCallback(() => fetchSoulDetail(slug), [slug]);
  const { data, loading, error } = useAsyncResource(fetcher, [slug]);
  return (
    <PreviewModal title={data?.displayName ?? ""} onClose={onClose}>
      {loading && <CenterLoader />}
      {error && <ErrorState message={error} onRetry={onClose} />}
      {data && (
        <div>
          <p className="mb-4 text-sm" style={{ color: "rgba(0,0,0,0.65)" }}>
            {data.summary}
          </p>
          <SoulSpecRenderer content={data.content} />
        </div>
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
  return (
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
            className="text-xs font-medium transition-colors"
            style={{ color: "rgba(0,0,0,0.60)" }}
          >
            {t("关闭")}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>
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
