import type { ReactNode } from "react";

import { LightVelaFooter, type RenderFooterLink } from "@/components/site/lightvela-footer";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import { useT } from "@/i18n/t";
import { publicSiteHref, type PublicSiteLocale } from "@/lib/public-site-navigation";
import { cn } from "@/lib/utils";

import { formatBlogPublishedAt, getBlogPost, type BlogBlock, type BlogInline } from "./blog-content";
import { BlogShareActions } from "./blog-share-actions";

type BlogArticlePageProps = {
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
  slug: string;
};

function articleHref(href: string, locale: PublicSiteLocale | undefined, localized: boolean | undefined): string {
  if (!locale || !href.startsWith("/")) return href;
  return publicSiteHref(href, locale, { localized });
}

function renderInline(
  content: readonly BlogInline[],
  locale: PublicSiteLocale | undefined,
  localized: boolean | undefined,
): ReactNode {
  return content.map((part, index) => {
    if (typeof part === "string") return <span key={index}>{part}</span>;
    const external = part.href.startsWith("http");
    return (
      <a
        key={`${part.href}-${index}`}
        href={articleHref(part.href, locale, localized)}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        className="underline decoration-black/25 underline-offset-4 transition-colors hover:decoration-black"
      >
        {part.label}
      </a>
    );
  });
}

function renderBlock(
  block: BlogBlock,
  index: number,
  locale: PublicSiteLocale | undefined,
  localized: boolean | undefined,
): ReactNode {
  switch (block.type) {
    case "heading":
      return (
        <h2 key={index} className="text-balance pt-6 text-xl font-semibold leading-7 text-black sm:text-2xl">
          {block.text}
        </h2>
      );
    case "paragraph":
      return (
        <p
          key={index}
          className={
            block.emphasis
              ? "text-pretty text-lg font-medium leading-[1.75rem] text-black"
              : "text-pretty text-base leading-7 text-black/75"
          }
        >
          {renderInline(block.content, locale, localized)}
        </p>
      );
    case "image":
      return (
        <figure key={index} className="my-6">
          <img
            src={block.src}
            alt={block.alt}
            className={cn(
              "h-auto object-contain",
              block.size === "narrow" ? "mx-auto w-full max-w-[220px]" : "w-full",
            )}
          />
        </figure>
      );
    case "ordered-list":
      return (
        <ol key={index} aria-label={block.ariaLabel} className="list-decimal space-y-2 pl-6 text-base leading-7 text-black/75">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, locale, localized)}</li>
          ))}
        </ol>
      );
    case "unordered-list":
      return (
        <ul key={index} className="list-disc space-y-2 pl-6 text-base leading-7 text-black/75">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, locale, localized)}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto whitespace-pre-wrap bg-black/[0.035] px-5 py-4 text-sm leading-6 text-black/75">
          <code>{block.content}</code>
        </pre>
      );
  }
}

export function BlogArticlePage({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
  slug,
}: BlogArticlePageProps) {
  const t = useT();
  const post = getBlogPost(slug);
  const renderFooterLink: RenderFooterLink | undefined = renderLink
    ? ({ "aria-label": ariaLabel, children, className, href, onClick }) =>
        renderLink({ ariaLabel, children, className, href, onClick })
    : undefined;

  if (!post) return null;

  const blogHref = publicLocale
    ? publicSiteHref("/blog", publicLocale, { localized: publicLocalized })
    : "/blog";
  const articlePath = currentPath?.startsWith("/") ? currentPath : `/blog/${post.slug}`;
  const coverBlock = post.content[0];
  const coverAlt = coverBlock?.type === "image" ? coverBlock.alt : post.title;

  return (
    <div className="landing-page flex min-h-screen flex-col bg-white text-black">
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        locale={publicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />
      <main className="flex-1 px-6 pb-24 pt-[116px] sm:px-10">
        <article lang="en" className="mx-auto w-full max-w-5xl">
          <a
            href={blogHref}
            aria-label={t("返回")}
            className="inline-flex items-center gap-2 text-sm text-black/50 transition-colors hover:text-black"
          >
            <span aria-hidden="true" className="no-underline">
              ←
            </span>
            <span className="underline decoration-black/20 underline-offset-4">{t("返回")}</span>
          </a>
          <img
            src={post.coverImage}
            alt={coverAlt}
            className="mt-8 aspect-video w-full rounded-md object-cover"
          />
          <h1 className="mt-8 text-pretty text-3xl font-bold leading-tight text-black sm:text-4xl">{post.title}</h1>
          <div className="mt-5 text-sm text-black/45">
            <time dateTime={post.publishedAt}>{formatBlogPublishedAt(post.publishedAt, publicLocale)}</time>
            <span aria-hidden="true"> · </span>
            <span>{post.author}</span>
          </div>
          <div className="mt-8 space-y-4">
            {post.content.slice(1).map((block, index) => renderBlock(block, index, publicLocale, publicLocalized))}
          </div>
          <BlogShareActions path={articlePath} title={post.title} />
        </article>
      </main>
      <LightVelaFooter renderLink={renderFooterLink} />
    </div>
  );
}
