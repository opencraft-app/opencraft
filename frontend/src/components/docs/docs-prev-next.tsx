/**
 * 文档正文底部的"上一篇 / 下一篇"导航。顺序依据 `FLAT_SLUGS`。
 */

import { Link } from "react-router-dom";
import { FLAT_SLUGS } from "@/config/docs-sidebar";

interface Props {
  currentSlug: string;
}

export function DocsPrevNext({ currentSlug }: Props) {
  const idx = FLAT_SLUGS.findIndex((s) => s.slug === currentSlug);
  if (idx < 0) return null;

  const prev = idx > 0 ? FLAT_SLUGS[idx - 1] : null;
  const next = idx < FLAT_SLUGS.length - 1 ? FLAT_SLUGS[idx + 1] : null;

  return (
    <div className="mt-16 pt-8 border-t border-[var(--border-subtle)] grid grid-cols-1 md:grid-cols-2 gap-4">
      {prev ? (
        <Link
          to={`/docs/${prev.slug}`}
          className="group block p-4 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--text-primary)] transition-colors"
        >
          <div className="text-xs text-[var(--text-tertiary)] mb-1">← 上一篇</div>
          <div className="font-medium text-[var(--text-primary)] group-hover:underline">
            {prev.title}
          </div>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          to={`/docs/${next.slug}`}
          className="group block p-4 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--text-primary)] transition-colors text-right"
        >
          <div className="text-xs text-[var(--text-tertiary)] mb-1">下一篇 →</div>
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
