/**
 * 文档页主体：三栏布局（左 Sidebar / 中 Content / 右 TOC）。
 *
 * 路由形态：
 *   - /docs                      → 在 router 里重定向到 /docs/overview
 *   - /docs/:slug
 *   - /docs/:category/:slug     （例如 /docs/configuration/model）
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MarkdownRenderer } from "@/components/docs/markdown-renderer";
import { DocsSidebar } from "@/components/docs/docs-sidebar";
import { DocsToc, type TocItem } from "@/components/docs/docs-toc";
import { DocsPrevNext } from "@/components/docs/docs-prev-next";
import {
  DEFAULT_SLUG,
  getLocalizedFlatSlugs,
  getLocalizedSidebar,
  isEnglishLocale,
} from "@/config/docs-sidebar";
import {
  fixBoldBoundary,
  getDocBySlug,
  rewriteImagePaths,
  rewriteMarkdownLinks,
} from "@/lib/docs/docs-loader";

/**
 * 根据 slug 计算面包屑：文档 › 分组 › 当前页。
 * 找不到分组时只返回 [文档, 当前页]；找不到当前页就只返回 [文档]。
 */
function buildBreadcrumb(slug: string, locale?: string): Array<{ label: string; to?: string }> {
  const crumbs: Array<{ label: string; to?: string }> = [
    { label: isEnglishLocale(locale) ? "Docs" : "文档", to: "/docs" },
  ];
  const sidebar = getLocalizedSidebar(locale);
  const flatSlugs = getLocalizedFlatSlugs(locale);
  const group = sidebar.find((g) => g.items.some((it) => it.slug === slug));
  const page = flatSlugs.find((s) => s.slug === slug);
  if (group) crumbs.push({ label: group.title });
  if (page) crumbs.push({ label: page.title });
  return crumbs;
}

export function DocsPage() {
  const params = useParams<{ category?: string; slug?: string }>();
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const [toc, setToc] = useState<TocItem[]>([]);

  // 拼出完整 slug：'configuration/model' 或 'overview'
  const slug = useMemo(() => {
    const parts: string[] = [];
    if (params.category) parts.push(params.category);
    if (params.slug) parts.push(params.slug);
    return parts.join("/") || DEFAULT_SLUG;
  }, [params]);

  const rawContent = getDocBySlug(slug, i18n.language);
  const content = rawContent
    ? fixBoldBoundary(rewriteImagePaths(rewriteMarkdownLinks(rawContent), i18n.language))
    : null;

  // 切页时的滚动归位由根布局的 <ScrollRestoration /> 统一处理：
  //   - 切路由 → 滚回顶部
  //   - 浏览器前进/后退 → 恢复历史位置
  // 这里不再自己 scrollTo，避免与后退恢复行为冲突。

  // 未知 slug 自动跳回默认页
  useEffect(() => {
    if (!rawContent && slug !== DEFAULT_SLUG) {
      navigate(`/docs/${DEFAULT_SLUG}`, { replace: true });
    }
  }, [rawContent, slug, navigate]);

  // 页面标题
  useEffect(() => {
    const found = getLocalizedFlatSlugs(i18n.language).find((s) => s.slug === slug);
    const docsTitle = isEnglishLocale(i18n.language) ? "LightVela Docs" : "LightVela 文档";
    document.title = found ? `${found.title} · ${docsTitle}` : docsTitle;
  }, [slug, i18n.language]);

  return (
    <main className="flex-1">
      <div className="mx-auto flex max-w-[1400px] gap-6 px-6">
        <DocsSidebar />
        <article className="min-w-0 flex-1 px-2 py-8 md:px-6">
          {content ? (
            <>
              <nav
                aria-label="breadcrumb"
                className="mb-3 text-[12px] text-[var(--text-tertiary)] flex items-center flex-wrap gap-1"
              >
                {buildBreadcrumb(slug, i18n.language).map((c, i, arr) => (
                  <span key={`${c.label}-${i}`} className="inline-flex items-center gap-1">
                    {c.to && i < arr.length - 1 ? (
                      <Link
                        to={c.to}
                        className="hover:text-[var(--text-primary)] transition-colors"
                      >
                        {c.label}
                      </Link>
                    ) : (
                      <span
                        className={
                          i === arr.length - 1
                            ? "text-[var(--text-secondary)]"
                            : undefined
                        }
                      >
                        {c.label}
                      </span>
                    )}
                    {i < arr.length - 1 && (
                      <span className="text-[var(--border-strong)]">›</span>
                    )}
                  </span>
                ))}
              </nav>
              <MarkdownRenderer content={content} onTocCollected={setToc} />
              <DocsPrevNext currentSlug={slug} />
            </>
          ) : (
            <div className="text-[var(--text-tertiary)]">加载中…</div>
          )}
        </article>
        <DocsToc items={toc} />
      </div>
    </main>
  );
}
