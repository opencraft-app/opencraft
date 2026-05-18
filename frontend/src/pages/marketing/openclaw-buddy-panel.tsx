/**
 * AI 搭子面板（v0.5）
 *
 * 在 Hermes 实例 Settings 内，从 SkillHub 公共接口拉取 Soul（人设）和
 * SkillSet（技能包）目录展示。仅只读浏览，**不涉及抽卡 / 创建组合 /
 * 安装到 bot** —— 这些依赖鉴权，等"mono2 后端代理 + service token"方案
 * 落地后再做。
 *
 * 数据来源：`@/lib/skillhub-api`，跨域直连 https://api.skillhub.cn 的
 * 公共接口（lightclaw.tech 已在其 CORS 白名单内）。
 */

import { ExternalLink, Loader2, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { useT } from "@/i18n/t";
import { useAsyncResource } from "@/services/use-async-resource";
import { MarkdownRenderer } from "@/components/docs/markdown-renderer";
import {
  fetchSkillSetDetail,
  fetchSkillSets,
  fetchSoulDetail,
  fetchSouls,
  type SkillHubSkillSet,
  type SkillHubSoul,
} from "@/lib/skillhub-api";

type BuddyTab = "souls" | "skillsets";

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
  const [activeTab, setActiveTab] = useState<BuddyTab>("souls");
  const [previewSoulSlug, setPreviewSoulSlug] = useState<string | null>(null);
  const [previewSkillSetSlug, setPreviewSkillSetSlug] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-2xl" style={PANEL_CARD_STYLE}>
      {/* 头部：标题 + 跳转完整版 */}
      <div
        className="flex items-center gap-3 px-6 py-4"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-xl"
          style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.90)" }}
        >
          <Users className="h-4 w-4" />
        </div>
        <h3
          className="flex-1 text-base font-semibold"
          style={{ color: "rgba(0,0,0,0.90)", letterSpacing: "-0.2px" }}
        >
          {t("AI 搭子")}
        </h3>
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
          "浏览 SkillHub 提供的 AI 人设和技能包目录。抽卡选择、组装、一键安装到 LightVela 实例的能力正在接入中。",
        )}
      </div>

      {/* 子 Tab：人设 / 技能包 */}
      <div
        className="flex gap-1 px-6 pt-4"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}
      >
        {(
          [
            { id: "souls", label: t("人设") },
            { id: "skillsets", label: t("技能包") },
          ] as { id: BuddyTab; label: string }[]
        ).map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="px-3 py-2 text-sm font-medium transition-colors"
              style={{
                color: isActive ? "rgba(0,0,0,0.90)" : "rgba(0,0,0,0.50)",
                borderBottom: isActive
                  ? "2px solid rgba(0,0,0,0.90)"
                  : "2px solid transparent",
                marginBottom: "-1px",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 内容区 */}
      <div className="p-6">
        {activeTab === "souls" && (
          <SoulList onPick={(slug) => setPreviewSoulSlug(slug)} />
        )}
        {activeTab === "skillsets" && (
          <SkillSetList onPick={(slug) => setPreviewSkillSetSlug(slug)} />
        )}
      </div>

      {previewSoulSlug && (
        <SoulPreviewModal slug={previewSoulSlug} onClose={() => setPreviewSoulSlug(null)} />
      )}
      {previewSkillSetSlug && (
        <SkillSetPreviewModal
          slug={previewSkillSetSlug}
          onClose={() => setPreviewSkillSetSlug(null)}
        />
      )}
    </div>
  );
}

// ─── 列表组件 ───────────────────────────────────────────────────────────────

function SoulList({ onPick }: { onPick: (slug: string) => void }) {
  const t = useT();
  // useCallback 是为了让 fetcher 引用在 render 间保持稳定。useAsyncResource 内部
  // 用 useCallback([fetcher]) 派生 run，并把 run 作为 useEffect 依赖；如果直接传
  // 内联箭头函数，每次 render 都是新引用 → run 变 → effect 重跑 → 无限请求。
  const fetcher = useCallback(() => fetchSouls({ page: 1, pageSize: 30 }), []);
  const { data, loading, error, reload } = useAsyncResource(fetcher, []);

  if (loading) return <CenterLoader />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const souls = data?.souls ?? [];
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

function SkillSetList({ onPick }: { onPick: (slug: string) => void }) {
  const t = useT();
  const fetcher = useCallback(() => fetchSkillSets({ page: 1, pageSize: 30 }), []);
  const { data, loading, error, reload } = useAsyncResource(fetcher, []);

  if (loading) return <CenterLoader />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const sets = data?.skillSets ?? [];
  if (sets.length === 0) {
    return <EmptyState text={t("暂无技能包数据")} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {sets.map((set) => (
        <SkillSetCard key={set.slug} set={set} onClick={() => onPick(set.slug)} />
      ))}
    </ul>
  );
}

function SkillSetCard({ set, onClick }: { set: SkillHubSkillSet; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col gap-1.5 rounded-xl px-4 py-3 text-left transition-colors hover:bg-[rgba(0,0,0,0.02)]"
        style={ITEM_CARD_STYLE}
      >
        <div className="text-sm font-semibold" style={{ color: "rgba(0,0,0,0.90)" }}>
          {set.displayName}
        </div>
        <div
          className="line-clamp-3 text-xs leading-relaxed"
          style={{ color: "rgba(0,0,0,0.55)" }}
        >
          {set.summary}
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

function SkillSetPreviewModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const fetcher = useCallback(() => fetchSkillSetDetail(slug), [slug]);
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
