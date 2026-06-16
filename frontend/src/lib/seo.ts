import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { isGlobal } from "@/lib/region";
import { getSeoMeta, type SeoMeta } from "@/lib/seo-data";
export { DEFAULT_SEO_TITLE, SEO_DESCRIPTION, SEO_KEYWORDS, getSeoMeta } from "@/lib/seo-data";

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

export function applySeoMeta(meta: SeoMeta): void {
  // 仅在实际变化时写 DOM：单次路由切换最多 1 次 title + 2 次 meta，
  // 且重复值（如多个 layout 共享同一 meta）不会产生冗余写入。
  if (document.title !== meta.title) {
    document.title = meta.title;
  }
  upsertMetaTag("description", meta.description);
  upsertMetaTag("keywords", meta.keywords);
}

export function useRouteSeoMeta(): void {
  const location = useLocation();

  useEffect(() => {
    applySeoMeta(getSeoMeta(location.pathname, SEO_REGION));
  }, [location.pathname]);
}
