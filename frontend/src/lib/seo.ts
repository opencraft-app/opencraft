import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { getSeoMeta, type SeoMeta } from "@/lib/seo-data";
export { DEFAULT_SEO_TITLE, SEO_DESCRIPTION, SEO_KEYWORDS, getSeoMeta } from "@/lib/seo-data";

function upsertMetaTag(name: string, content: string): void {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);

  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", name);
    document.head.appendChild(meta);
  }

  meta.setAttribute("content", content);
}

export function applySeoMeta(meta: SeoMeta): void {
  document.title = meta.title;
  upsertMetaTag("description", meta.description);
  upsertMetaTag("keywords", meta.keywords);
}

export function useRouteSeoMeta(): void {
  const location = useLocation();

  useEffect(() => {
    applySeoMeta(getSeoMeta(location.pathname));
  }, [location.pathname]);
}
