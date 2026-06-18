/**
 * 文档正文底部的"上一篇 / 下一篇"导航。顺序依据 `FLAT_SLUGS`。
 */

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getLocalizedFlatSlugs, isEnglishLocale } from "@/config/docs-sidebar";
import { localizedPath } from "@/lib/region";

interface Props {
  currentSlug: string;
}

export function DocsPrevNext({ currentSlug }: Props) {
  const { i18n } = useTranslation();
  const flatSlugs = getLocalizedFlatSlugs(i18n.language);
  const idx = flatSlugs.findIndex((s) => s.slug === currentSlug);
  if (idx < 0) return null;

  const prev = idx > 0 ? flatSlugs[idx - 1] : null;
  const next = idx < flatSlugs.length - 1 ? flatSlugs[idx + 1] : null;
  const isEnglish = isEnglishLocale(i18n.language);
  /* 国际站把上一篇/下一篇链接也带上 `/en` `/zh` 前缀，保证 history 与地址栏
     形态稳定；国内站 localizedPath() 返回原值，零行为变化。 */
  const i18nLocale: "zh-CN" | "en-US" =
    i18n.language === "zh-CN" || i18n.language === "en-US" ? i18n.language : "en-US";

  return (
    <div className="mt-16 pt-8 border-t border-[var(--border-subtle)] grid grid-cols-1 md:grid-cols-2 gap-4">
      {prev ? (
        <Link
          to={localizedPath(`/docs/${prev.slug}`, i18nLocale)}
          className="group block p-4 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--text-primary)] transition-colors"
        >
          <div className="text-xs text-[var(--text-tertiary)] mb-1">← {isEnglish ? "Previous" : "上一篇"}</div>
          <div className="font-medium text-[var(--text-primary)] group-hover:underline">
            {prev.title}
          </div>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          to={localizedPath(`/docs/${next.slug}`, i18nLocale)}
          className="group block p-4 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--text-primary)] transition-colors text-right"
        >
          <div className="text-xs text-[var(--text-tertiary)] mb-1">{isEnglish ? "Next" : "下一篇"} →</div>
          <div className="font-medium text-[var(--text-primary)] group-hover:underline">
            {next.title}
          </div>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
