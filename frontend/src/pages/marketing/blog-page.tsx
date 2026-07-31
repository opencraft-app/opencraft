/**
 * 博客（科普）页面
 *
 * 提供两个导出：
 * - BlogListPage：/blog 列表页（含分类切换）
 * - BlogArticlePage：/blog/[slug] 文章详情页
 *
 * 设计约定：
 * - 布局与 changelog-page 对齐（同一份 header + legal-footer + 主体 max-w 1200）。
 * - 内容仅通过 blog-content.ts 数据源渲染，不引入 i18next 的 t()，
 *   因为博客本身是多语言并列文本；locale 由 publicLocale prop 决定。
 * - 保持轻量 motion 动画，避免额外依赖。
 * - 使用 framer-motion + LegalFooter（内含 useState），必须是 Client Component。
 */

"use client";

import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";

import { LegalFooter } from "@/components/site/legal-footer";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import { publicSiteHref, type PublicSiteLocale } from "@/lib/public-site-navigation";
import {
  BLOG_CATEGORIES,
  getBlogArticleBySlug,
  getBlogCategoryById,
  getSortedBlogArticles,
  pickBlogText,
  type BlogArticle,
  type BlogCategory,
} from "@/pages/marketing/blog-content";

/* ═══════════════════════════════════════════════════════════════
   Animation
   ═══════════════════════════════════════════════════════════════ */

const fadeInUp = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

const viewportConfig = { once: true, margin: "-40px" as const };

/* ═══════════════════════════════════════════════════════════════
   国际化词条（仅 blog 页面壳层用到的少量固定文案）
   —— 严格控制在极简范围，避免走 i18next 的翻译扫描/回填流程
   ═══════════════════════════════════════════════════════════════ */

type UiLocaleMap = Record<PublicSiteLocale, string>;

const UI_STRINGS = {
  blogTitle: {
    "zh-CN": "科普",
    "zh-SG": "科普",
    "en-US": "Blog",
  } as UiLocaleMap,
  blogIntro: {
    "zh-CN": "拆解下一代 Agent 的关键机制，聊一聊我们理解世界的方式。",
    "zh-SG": "拆解下一代 Agent 的關鍵機制，聊一聊我們理解世界的方式。",
    "en-US":
      "Breakdowns of what makes next-generation agents tick — and how we see the future of AI companions.",
  } as UiLocaleMap,
  allArticles: {
    "zh-CN": "全部文章",
    "zh-SG": "全部文章",
    "en-US": "All posts",
  } as UiLocaleMap,
  readMore: {
    "zh-CN": "阅读全文 →",
    "zh-SG": "閱讀全文 →",
    "en-US": "Read more →",
  } as UiLocaleMap,
  backToList: {
    "zh-CN": "← 返回科普列表",
    "zh-SG": "← 返回科普列表",
    "en-US": "← Back to blog",
  } as UiLocaleMap,
  publishedOn: {
    "zh-CN": "发布于",
    "zh-SG": "發布於",
    "en-US": "Published on",
  } as UiLocaleMap,
  notFoundTitle: {
    "zh-CN": "文章未找到",
    "zh-SG": "文章未找到",
    "en-US": "Article not found",
  } as UiLocaleMap,
  notFoundHint: {
    "zh-CN": "这篇文章可能已被删除或调整链接，先返回列表看看其它内容。",
    "zh-SG": "這篇文章可能已被刪除或調整連結，先返回列表看看其他內容。",
    "en-US":
      "This article may have been moved or removed. Head back to the list to explore other posts.",
  } as UiLocaleMap,
};

function ui(key: keyof typeof UI_STRINGS, locale: PublicSiteLocale): string {
  return UI_STRINGS[key][locale] || UI_STRINGS[key]["en-US"];
}

/* ═══════════════════════════════════════════════════════════════
   工具
   ═══════════════════════════════════════════════════════════════ */

function formatDate(date: string, locale: PublicSiteLocale): string {
  /* 保证 SSR 一致：使用 UTC 拆分而非依赖 host 时区。 */
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  const [y, m, d] = parts;
  if (locale === "en-US") {
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthIdx = Math.max(0, Math.min(11, Number(m) - 1));
    return `${monthNames[monthIdx]} ${Number(d)}, ${y}`;
  }
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
}

function blogHref(
  slug: string | null,
  locale: PublicSiteLocale,
  localized: boolean,
): string {
  const base = slug ? `/blog/${slug}` : "/blog";
  return publicSiteHref(base, locale, { localized });
}

/* ═══════════════════════════════════════════════════════════════
   List Page
   ═══════════════════════════════════════════════════════════════ */

type CommonPageProps = {
  authControls?: ReactNode;
  currentPath?: string;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: {
    activeLocale: PublicSiteLocale;
    reloadAfterSwitch: boolean;
    variant: LanguageSwitcherVariant;
  }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};

type BlogListPageProps = CommonPageProps & {
  /**
   * 初始选中的分类；未提供或为 null 时默认展示"全部"。
   * 由于站点是纯静态导出（output: "export"），此处不消费 URL search params，
   * 分类切换完全在客户端 state 中完成。
   */
  initialCategoryId?: string | null;
};

function BlogListContent({
  publicLocale = "zh-CN",
  publicLocalized = false,
  initialCategoryId = null,
}: {
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  initialCategoryId?: string | null;
}) {
  const locale = publicLocale;
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(initialCategoryId);

  const filtered = activeCategoryId
    ? getSortedBlogArticles().filter((a) => a.categoryId === activeCategoryId)
    : getSortedBlogArticles();

  const activeCategory: BlogCategory | undefined = activeCategoryId
    ? getBlogCategoryById(activeCategoryId)
    : undefined;

  const pageTitle = activeCategory
    ? pickBlogText(activeCategory.label, locale)
    : ui("blogTitle", locale);
  const pageIntro = activeCategory
    ? pickBlogText(activeCategory.description, locale)
    : ui("blogIntro", locale);

  return (
    <section
      style={{ backgroundColor: "var(--lw-bg)", paddingTop: "8rem", paddingBottom: "6rem" }}
    >
      <div className="mx-auto px-6 md:px-8" style={{ maxWidth: "1200px" }}>
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="mb-12"
        >
          <motion.h1
            variants={fadeInUp}
            style={{
              fontSize: "clamp(2.5rem, 5vw, 3rem)",
              fontWeight: 600,
              color: "var(--lw-fg)",
              letterSpacing: "-0.02em",
              lineHeight: 1.33,
            }}
          >
            {pageTitle}
          </motion.h1>
          <motion.p
            variants={fadeInUp}
            className="mt-4 text-base"
            style={{
              color: "rgba(0,0,0,0.5)",
              lineHeight: 1.5,
              maxWidth: "720px",
            }}
          >
            {pageIntro}
          </motion.p>
        </motion.div>

        {/* 分类导航条 */}
        <motion.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          className="mb-12 flex flex-wrap gap-2"
        >
          <CategoryChip
            label={ui("allArticles", locale)}
            active={!activeCategoryId}
            onClick={() => setActiveCategoryId(null)}
          />
          {BLOG_CATEGORIES.map((c) => (
            <CategoryChip
              key={c.id}
              label={pickBlogText(c.label, locale)}
              active={activeCategoryId === c.id}
              onClick={() => setActiveCategoryId(c.id)}
            />
          ))}
        </motion.div>

        {/* 文章卡片列表 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="grid grid-cols-1 gap-8"
        >
          {filtered.map((article) => (
            <ArticleCard
              key={article.slug}
              article={article}
              locale={locale}
              localized={publicLocalized}
            />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 14px",
        borderRadius: "999px",
        fontSize: "14px",
        lineHeight: 1.5,
        border: "1px solid rgba(0,0,0,0.12)",
        color: active ? "var(--lw-bg)" : "rgba(0,0,0,0.7)",
        backgroundColor: active ? "var(--lw-fg)" : "transparent",
        cursor: "pointer",
        transition: "background-color 0.2s ease, color 0.2s ease",
      }}
    >
      {label}
    </button>
  );
}

function ArticleCard({
  article,
  locale,
  localized,
}: {
  article: BlogArticle;
  locale: PublicSiteLocale;
  localized: boolean;
}) {
  const category = getBlogCategoryById(article.categoryId);

  return (
    <motion.article
      variants={fadeInUp}
      style={{
        borderRadius: "20px",
        border: "1px solid rgba(0,0,0,0.08)",
        padding: "28px 32px",
        backgroundColor: "rgba(255,255,255,0.5)",
      }}
    >
      <div
        className="mb-3 flex items-center gap-3"
        style={{ color: "rgba(0,0,0,0.5)", fontSize: "14px" }}
      >
        {category && (
          <span
            style={{
              padding: "2px 10px",
              borderRadius: "999px",
              backgroundColor: "rgba(0,0,0,0.06)",
              color: "rgba(0,0,0,0.7)",
              fontSize: "12px",
            }}
          >
            {pickBlogText(category.label, locale)}
          </span>
        )}
        <span>{formatDate(article.date, locale)}</span>
      </div>

      <h2
        style={{
          fontSize: "24px",
          fontWeight: 500,
          color: "var(--lw-fg)",
          lineHeight: 1.4,
          letterSpacing: "-0.01em",
          marginBottom: "12px",
        }}
      >
        <a
          href={blogHref(article.slug, locale, localized)}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {pickBlogText(article.title, locale)}
        </a>
      </h2>

      <p
        style={{
          fontSize: "16px",
          color: "rgba(0,0,0,0.7)",
          lineHeight: 1.75,
          marginBottom: "20px",
        }}
      >
        {pickBlogText(article.summary, locale)}
      </p>

      <a
        href={blogHref(article.slug, locale, localized)}
        style={{
          color: "var(--lw-fg)",
          fontSize: "15px",
          fontWeight: 500,
          textDecoration: "none",
        }}
      >
        {ui("readMore", locale)}
      </a>
    </motion.article>
  );
}

export const BlogListPage = ({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
  initialCategoryId = null,
}: BlogListPageProps = {}) => {
  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
    >
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        currentSection="blog"
        locale={publicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />
      <main className="z-10 flex-grow pt-[60px]">
        <BlogListContent
          publicLocale={publicLocale}
          publicLocalized={publicLocalized}
          initialCategoryId={initialCategoryId}
        />
      </main>
      <LegalFooter />
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   Article Detail Page
   ═══════════════════════════════════════════════════════════════ */

type BlogArticlePageProps = CommonPageProps & {
  slug: string;
};

function BlogArticleContent({
  slug,
  publicLocale = "zh-CN",
  publicLocalized = false,
}: {
  slug: string;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
}) {
  const locale = publicLocale;
  const article = getBlogArticleBySlug(slug);

  if (!article) {
    return (
      <section
        style={{ backgroundColor: "var(--lw-bg)", paddingTop: "8rem", paddingBottom: "6rem" }}
      >
        <div className="mx-auto px-6 md:px-8" style={{ maxWidth: "720px" }}>
          <h1
            style={{
              fontSize: "clamp(2rem, 4vw, 2.5rem)",
              fontWeight: 600,
              color: "var(--lw-fg)",
              marginBottom: "16px",
            }}
          >
            {ui("notFoundTitle", locale)}
          </h1>
          <p
            style={{
              fontSize: "16px",
              color: "rgba(0,0,0,0.7)",
              lineHeight: 1.75,
              marginBottom: "32px",
            }}
          >
            {ui("notFoundHint", locale)}
          </p>
          <a
            href={blogHref(null, locale, publicLocalized)}
            style={{
              color: "var(--lw-fg)",
              fontSize: "15px",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            {ui("backToList", locale)}
          </a>
        </div>
      </section>
    );
  }

  const category = getBlogCategoryById(article.categoryId);

  return (
    <section
      style={{ backgroundColor: "var(--lw-bg)", paddingTop: "8rem", paddingBottom: "6rem" }}
    >
      <div className="mx-auto px-6 md:px-8" style={{ maxWidth: "780px" }}>
        <motion.a
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          href={blogHref(null, locale, publicLocalized)}
          style={{
            display: "inline-block",
            marginBottom: "24px",
            fontSize: "14px",
            color: "rgba(0,0,0,0.6)",
            textDecoration: "none",
          }}
        >
          {ui("backToList", locale)}
        </motion.a>

        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
        >
          <motion.div
            variants={fadeInUp}
            className="mb-3 flex items-center gap-3"
            style={{ color: "rgba(0,0,0,0.5)", fontSize: "14px" }}
          >
            {category && (
              <span
                style={{
                  padding: "2px 10px",
                  borderRadius: "999px",
                  backgroundColor: "rgba(0,0,0,0.06)",
                  color: "rgba(0,0,0,0.7)",
                  fontSize: "12px",
                }}
              >
                {pickBlogText(category.label, locale)}
              </span>
            )}
            <span>
              {ui("publishedOn", locale)} {formatDate(article.date, locale)}
            </span>
          </motion.div>

          <motion.h1
            variants={fadeInUp}
            style={{
              fontSize: "clamp(2rem, 4.5vw, 2.75rem)",
              fontWeight: 600,
              color: "var(--lw-fg)",
              letterSpacing: "-0.02em",
              lineHeight: 1.25,
              marginBottom: "16px",
            }}
          >
            {pickBlogText(article.title, locale)}
          </motion.h1>

          <motion.p
            variants={fadeInUp}
            style={{
              fontSize: "18px",
              color: "rgba(0,0,0,0.7)",
              lineHeight: 1.7,
              marginBottom: "40px",
            }}
          >
            {pickBlogText(article.summary, locale)}
          </motion.p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
        >
          {article.sections.map((section, idx) => (
            <motion.div key={idx} variants={fadeInUp} className="mb-10">
              {section.heading && (
                <h2
                  style={{
                    fontSize: "22px",
                    fontWeight: 600,
                    color: "var(--lw-fg)",
                    lineHeight: 1.5,
                    letterSpacing: "-0.01em",
                    marginBottom: "16px",
                  }}
                >
                  {pickBlogText(section.heading, locale)}
                </h2>
              )}
              {section.paragraphs.map((p, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: "16px",
                    color: "rgba(0,0,0,0.85)",
                    lineHeight: 1.85,
                    marginBottom: "16px",
                  }}
                >
                  {pickBlogText(p, locale)}
                </p>
              ))}
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

export const BlogArticlePage = ({
  slug,
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: BlogArticlePageProps) => {
  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
    >
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        currentSection="blog"
        locale={publicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />
      <main className="z-10 flex-grow pt-[60px]">
        <BlogArticleContent
          slug={slug}
          publicLocale={publicLocale}
          publicLocalized={publicLocalized}
        />
      </main>
      <LegalFooter />
    </div>
  );
};

/** 用于 SSG 的 slug 列表（服务端安全，从 blog-content 转出口）。 */
export { listBlogArticleSlugs } from "@/pages/marketing/blog-content";
