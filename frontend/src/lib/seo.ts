import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { isGlobal } from "@/lib/region";
import {
  getFullSeoMeta,
  isPathIndexable,
  type FullSeoMeta,
  type SeoMeta,
} from "@/lib/seo-data";
export {
  DEFAULT_SEO_TITLE,
  SEO_DESCRIPTION,
  SEO_KEYWORDS,
  getSeoMeta,
  getFullSeoMeta,
} from "@/lib/seo-data";

/** 当前站点 region（编译期常量），用于让 SEO 文案按国内/国际切换中英文。 */
const SEO_REGION = isGlobal ? "global" : "cn";

function upsertMetaTag(name: string, content: string): void {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);

  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", name);
    document.head.appendChild(meta);
  }

  // 内容未变化时跳过写入，避免每次路由切换都触发不必要的 DOM 写。
  if (meta.getAttribute("content") !== content) {
    meta.setAttribute("content", content);
  }
}

function upsertMetaProperty(property: string, content: string): void {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);

  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("property", property);
    document.head.appendChild(meta);
  }

  if (meta.getAttribute("content") !== content) {
    meta.setAttribute("content", content);
  }
}

function upsertLink(rel: string, href: string): void {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);

  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", rel);
    document.head.appendChild(link);
  }

  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
  }
}

/**
 * 仅同步 title / description / keywords 的轻量版本（向后兼容旧调用方）。
 * 若需要同步 OG / Twitter / canonical / robots，请使用 `applyFullSeoMeta`。
 */
export function applySeoMeta(meta: SeoMeta): void {
  // 仅在实际变化时写 DOM：单次路由切换最多 1 次 title + 2 次 meta，
  // 且重复值（如多个 layout 共享同一 meta）不会产生冗余写入。
  if (document.title !== meta.title) {
    document.title = meta.title;
  }
  upsertMetaTag("description", meta.description);
  upsertMetaTag("keywords", meta.keywords);
}

/**
 * 同步完整 SEO 元数据：除了 title/description/keywords 外，
 * 还同步 robots、canonical、Open Graph、Twitter Card、`<html lang>`。
 *
 * 出发点：站内导航后用户复制当前 URL 分享到微信 / Twitter，社交平台抓取的
 * 是当前 SPA HTML 的 head；若不同步，分享卡内容仍是首屏 / 上一路由的旧值。
 */
export function applyFullSeoMeta(meta: FullSeoMeta): void {
  if (document.title !== meta.title) {
    document.title = meta.title;
  }

  if (document.documentElement.getAttribute("lang") !== meta.htmlLang) {
    document.documentElement.setAttribute("lang", meta.htmlLang);
  }

  upsertMetaTag("description", meta.description);
  upsertMetaTag("keywords", meta.keywords);
  upsertMetaTag("robots", meta.robots);

  upsertLink("canonical", meta.canonical);

  upsertMetaProperty("og:locale", meta.ogLocale);
  upsertMetaProperty("og:type", meta.ogType);
  upsertMetaProperty("og:site_name", meta.ogSiteName);
  upsertMetaProperty("og:title", meta.ogTitle);
  upsertMetaProperty("og:description", meta.ogDescription);
  upsertMetaProperty("og:url", meta.ogUrl);
  upsertMetaProperty("og:image", meta.ogImage);

  upsertMetaTag("twitter:card", meta.twitterCard);
  upsertMetaTag("twitter:title", meta.twitterTitle);
  upsertMetaTag("twitter:description", meta.twitterDescription);
  upsertMetaTag("twitter:image", meta.twitterImage);
}

export function useRouteSeoMeta(): void {
  const location = useLocation();

  useEffect(() => {
    // 客户端 origin 即为站点 URL，避免硬编码；SSR / prerender 走另一条管线。
    const siteUrl =
      typeof window !== "undefined" && window.location ? window.location.origin : undefined;
    const meta = getFullSeoMeta(location.pathname, SEO_REGION, {
      siteUrl,
      indexable: isPathIndexable(location.pathname),
    });
    applyFullSeoMeta(meta);
  }, [location.pathname]);
}
