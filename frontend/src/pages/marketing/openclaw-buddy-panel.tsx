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
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/t";
import { useAsyncResource } from "@/services/use-async-resource";
import { MarkdownRenderer } from "@/components/docs/markdown-renderer";
import { DrawSoulModal } from "@/pages/marketing/openclaw-buddy-draw-modal";
import { CardBack, SoulFaceCard } from "@/pages/marketing/openclaw-buddy-cards";
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

/** 抽卡槽位数上限（与 SkillHub `/hermes/edit-soul` 的卡片数量保持一致的体感） */
const MAX_DRAWS = 9;

export function BuddyPanel() {
  const t = useT();
  const [previewSoulSlug, setPreviewSoulSlug] = useState<string | null>(null);
  /** 已抽到的人设，按抽到顺序排列，去重 by slug，最多 MAX_DRAWS 张 */
  const [drawnSouls, setDrawnSouls] = useState<SkillHubSoul[]>([]);
  /** 抽卡弹窗开关 */
  const [drawOpen, setDrawOpen] = useState(false);

  /** 是否已经自动弹过一次抽卡 modal —— 用 ref 而非 state，避免触发额外 render。
   * 进入 BuddyPanel 时自动弹一次让用户立刻看到抽卡台；
   * 用户 X 关闭、抽完之后都不再自动弹。重新抽卡走头部"抽取人设"按钮或点空卡。 */
  const hasAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (hasAutoOpenedRef.current) return;
    hasAutoOpenedRef.current = true;
    setDrawOpen(true);
  }, []);

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
          <button
            type="button"
            onClick={handleOpenDraw}
            disabled={souls.length === 0 || isAtMax}
            className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {isAtMax ? t("已抽满 9 张") : t("抽取人设")}
          </button>
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

      {/* 提示条 */}
      <div
        className="px-6 py-3 text-xs leading-relaxed"
        style={{
          background: "rgba(0,0,0,0.02)",
          color: "rgba(0,0,0,0.55)",
          borderBottom: "1px solid rgba(0,0,0,0.05)",
        }}
      >
        {t(
          "在 SkillHub 16 张 AI 人设里抽出你的 9 张专属卡牌。组装、一键安装到 LightVela 实例的能力正在接入中。",
        )}
      </div>

      {/* 内容区：9 格抽卡槽 */}
      <div className="p-6">
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
    <div className="grid grid-cols-3 gap-3 md:gap-4">
      {Array.from({ length: MAX_DRAWS }).map((_, i) => {
        const soul = drawnSouls[i];
        return soul ? (
          <FilledSlot
            key={soul.slug}
            soul={soul}
            onClick={() => onClickFilled(soul.slug)}
          />
        ) : (
          <EmptySlot key={`empty-${i}`} onClick={onClickEmpty} />
        );
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
    <button
      type="button"
      onClick={onClick}
      aria-label={t("点击空卡抽取人设")}
      className="block w-full cursor-pointer transition-transform duration-200 hover:-translate-y-1"
    >
      <CardBack iconClassName="h-12 w-12" />
    </button>
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
        <div className="prose-doc max-w-none">
          <p className="mb-4 text-sm" style={{ color: "rgba(0,0,0,0.65)" }}>
            {data.summary}
          </p>
          <MarkdownRenderer content={data.content} />
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
