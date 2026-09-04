import { useState, type ReactNode } from "react";

import { LegalFooter } from "@/components/site/legal-footer";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import { useT } from "@/i18n/t";
import { publicSiteHref, type PublicSiteLocale } from "@/lib/public-site-navigation";
import { cn } from "@/lib/utils";

import { BLOG_POSTS, formatBlogPublishedDate } from "./blog-content";

const BLOG_CATEGORIES = ["all", "announcement", "product", "use-case"] as const;

type BlogCategory = (typeof BLOG_CATEGORIES)[number];

function blogCategoryLabel(t: (text: string) => string, category: BlogCategory): string {
  switch (category) {
    case "all":
      return t("全部");
    case "announcement":
      return t("公告");
    case "product":
      return t("产品");
    case "use-case":
      return t("使用场景");
  }
}

type BlogPageProps = {
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

export function BlogPage({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: BlogPageProps = {}) {
  const t = useT();
  const [activeCategory, setActiveCategory] = useState<BlogCategory>("all");
  const visiblePosts = BLOG_POSTS.filter(
    (post) => activeCategory === "all" || post.category === activeCategory,
  );

  return (
    <div className="landing-page flex min-h-screen flex-col bg-white text-black">
      <PublicSiteHeader
        appearance="immersive"
        authControls={authControls}
        currentPath={currentPath}
        locale={publicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />
      <main className="relative isolate flex flex-1 overflow-hidden bg-white pt-[60px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] opacity-70 [background:repeating-linear-gradient(90deg,var(--border-strong)_0_1px,transparent_1px_16px)] [mask-image:linear-gradient(180deg,var(--text-primary)_0%,var(--text-tertiary)_58%,transparent_100%)]"
        />
        <section
          aria-labelledby="blog-heading"
          className="mx-auto flex w-full max-w-[1360px] flex-col items-center px-6 pb-96 pt-[clamp(8rem,20vh,14rem)] text-center"
        >
          <h1 id="blog-heading" className="text-balance text-5xl font-semibold sm:text-6xl">
            {t("博客")}
          </h1>
          <nav aria-label={t("博客分类")} className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-3">
            {BLOG_CATEGORIES.map((category) => {
              const active = activeCategory === category;
              const label = blogCategoryLabel(t, category);
              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    "relative border-0 px-0 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:underline focus-visible:underline-offset-4",
                    active ? "font-medium text-black" : "text-black/45 hover:text-black/75",
                  )}
                  onClick={() => setActiveCategory(category)}
                >
                  {label}
                  {active ? <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px bg-black" /> : null}
                </button>
              );
            })}
          </nav>
          <div className="mt-16 grid w-full gap-x-11 gap-y-16 text-left sm:grid-cols-2 lg:grid-cols-3">
            {visiblePosts.map((post) => {
              const href = publicLocale
                ? publicSiteHref(`/blog/${post.slug}`, publicLocale, { localized: publicLocalized })
                : `/blog/${post.slug}`;
              return (
                <a
                  key={post.slug}
                  href={href}
                  className="group block rounded-md border border-black/[0.08] bg-white p-3 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 focus-visible:ring-offset-2"
                >
                  <img
                    src={post.coverImage}
                    alt=""
                    className="aspect-[16/9] w-full rounded-md bg-white object-cover transition-opacity group-hover:opacity-80"
                  />
                  <h2
                    lang="en"
                    className="mt-4 min-h-[2.5rem] px-1 line-clamp-2 text-pretty text-base font-medium leading-5 text-black"
                  >
                    {post.title}
                  </h2>
                  <div className="mt-2 flex items-center gap-2 px-1 pb-1 text-sm text-black/50">
                    <span>{blogCategoryLabel(t, post.category)}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={post.publishedAt}>{formatBlogPublishedDate(post.publishedAt, publicLocale)}</time>
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      </main>
      <LegalFooter />
    </div>
  );
}
