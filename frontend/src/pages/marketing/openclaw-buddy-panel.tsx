/**
 * AI 搭子面板（v0.7）
 *
 * 在 Hermes 实例 Settings 内，从 SkillHub 公共接口拉取 Soul（人设）目录展示，
 * 并提供"抽人设"交互（视觉对齐 SkillHub /hermes 的 DrawModal）。
 *
 * 抽卡数据策略：**前端从公共 souls 池 Math.random**，不调 SkillHub 的
 * draw 接口（该接口需要 JWT Cookie 鉴权）。"创建组合 / 安装到 bot" 等用户态
 * 写操作仍依赖鉴权，等 mono2 后端代理 + service token 方案落地后再做。
 *
 * 数据来源：`@/lib/skillhub-api`，跨域直连 https://api.skillhub.cn 的
 * 公共接口（lightclaw.tech 已在其 CORS 白名单内）。
 *
 * 注：SkillSet（技能包）功能已下线，待"组装 + 一键安装"方案成熟后再恢复。
 */

import { ExternalLink, Loader2, Sparkles, Users, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/t";
import { useAsyncResource } from "@/services/use-async-resource";
import { MarkdownRenderer } from "@/components/docs/markdown-renderer";
import { DrawSoulModal } from "@/pages/marketing/openclaw-buddy-draw-modal";
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

const ITEM_CARD_STYLE: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.06)",
  background: "#ffffff",
};

export function BuddyPanel() {
  const t = useT();
  const [previewSoulSlug, setPreviewSoulSlug] = useState<string | null>(null);
  /** 已通过抽卡选中的 Soul，用于头部 chip 提示 */
  const [selectedSoul, setSelectedSoul] = useState<SkillHubSoul | null>(null);
  /** 抽卡弹窗开关 */
  const [drawOpen, setDrawOpen] = useState(false);

  /** 是否已经自动弹过一次抽卡 modal —— 用 ref 而非 state，避免触发额外 render。
   * 进入 BuddyPanel 时自动弹一次让用户立刻看到抽卡台；
   * 用户 X 关闭、抽完之后都不再自动弹。重新抽卡走头部"抽取人设"按钮。 */
  const hasAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (hasAutoOpenedRef.current) return;
    hasAutoOpenedRef.current = true;
    setDrawOpen(true);
  }, []);

  // souls 列表是 SoulList 与 DrawSoulModal 共用的数据源 —— 提到这一层统一拉取，
  // 避免 SoulList 内部 fetch 一次、DrawModal 再单独 fetch 一次。
  const soulsFetcher = useCallback(() => fetchSouls({ page: 1, pageSize: 30 }), []);
  const soulsResource = useAsyncResource(soulsFetcher, []);
  const souls = soulsResource.data?.souls ?? [];

  const handlePickFromDraw = useCallback((soul: SkillHubSoul) => {
    setSelectedSoul(soul);
    setDrawOpen(false);
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl" style={PANEL_CARD_STYLE}>
      {/* 头部：标题 + 抽卡按钮 + 跳转 SkillHub */}
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

        {selectedSoul && (
          <SelectedSoulChip
            soul={selectedSoul}
            onClear={() => setSelectedSoul(null)}
          />
        )}

        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setDrawOpen(true)}
            disabled={souls.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: "rgba(0,0,0,0.90)", color: "#ffffff" }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("抽取人设")}
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
          "浏览 SkillHub 提供的 AI 人设。抽卡选择、组装、一键安装到 LightVela 实例的能力正在接入中。",
        )}
      </div>

      {/* 内容区 */}
      <div className="p-6">
        <SoulList
          souls={souls}
          loading={soulsResource.loading}
          error={soulsResource.error}
          onReload={soulsResource.reload}
          onPick={(slug) => setPreviewSoulSlug(slug)}
        />
      </div>

      <DrawSoulModal
        open={drawOpen}
        souls={souls}
        onClose={() => setDrawOpen(false)}
        onPick={handlePickFromDraw}
      />

      {previewSoulSlug && (
        <SoulPreviewModal slug={previewSoulSlug} onClose={() => setPreviewSoulSlug(null)} />
      )}
    </div>
  );
}

// ─── 已选人设 chip ──────────────────────────────────────────────────────────

function SelectedSoulChip({
  soul,
  onClear,
}: {
  soul: SkillHubSoul;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
      style={{
        background: "rgba(255,122,69,0.10)",
        color: "#A85020",
      }}
    >
      <span style={{ color: "rgba(0,0,0,0.50)" }}>{t("已选")}</span>
      <span className="font-medium">{soul.displayName}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t("取消选中")}
        className="-mr-1 ml-0.5 transition-opacity hover:opacity-70"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── 列表组件 ───────────────────────────────────────────────────────────────

function SoulList({
  souls,
  loading,
  error,
  onReload,
  onPick,
}: {
  souls: SkillHubSoul[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onPick: (slug: string) => void;
}) {
  const t = useT();
  if (loading) return <CenterLoader />;
  if (error) return <ErrorState message={error} onRetry={onReload} />;
  if (souls.length === 0) {
    return <EmptyState text={t("暂无人设数据")} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {souls.map((soul) => (
        <SoulCard key={soul.slug} soul={soul} onClick={() => onPick(soul.slug)} />
      ))}
    </ul>
  );
}

function SoulCard({ soul, onClick }: { soul: SkillHubSoul; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col gap-1.5 rounded-xl px-4 py-3 text-left transition-colors hover:bg-[rgba(0,0,0,0.02)]"
        style={ITEM_CARD_STYLE}
      >
        <div className="text-sm font-semibold" style={{ color: "rgba(0,0,0,0.90)" }}>
          {soul.displayName}
        </div>
        <div
          className="line-clamp-2 text-xs leading-relaxed"
          style={{ color: "rgba(0,0,0,0.55)" }}
        >
          {soul.summary}
        </div>
      </button>
    </li>
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

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-10 text-center text-sm" style={{ color: "rgba(0,0,0,0.45)" }}>
      {text}
    </div>
  );
}
