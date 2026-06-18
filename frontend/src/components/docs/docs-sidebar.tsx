/**
 * 文档左侧侧边栏。结构由 `@/config/docs-sidebar` 定义。
 * 顶部包含全站搜索入口（Cmd+K / `/` 触发）。
 * 激活态走 mono2 "黑 + 灰底 + 加粗" 的克制风格，与 landing-navbar 一致。
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { getLocalizedSidebar } from "@/config/docs-sidebar";
import { DocsSearch } from "@/components/docs/docs-search";
import { localizedPath } from "@/lib/region";
import { cn } from "@/lib/utils";

export function DocsSidebar() {
  const { pathname } = useLocation();
  const { i18n } = useTranslation();
  const sidebar = useMemo(() => getLocalizedSidebar(i18n.language), [i18n.language]);
  /* 当前 slug：先剥掉国际站可能存在的 `/en` `/zh` 语言前缀，再剥掉 `/docs/` */
  const activeSlug = pathname.replace(/^\/(en|zh)(?=\/|$)/, "").replace(/^\/docs\/?/, "");
  const locale = (i18n.language === "zh-CN" || i18n.language === "en-US")
    ? i18n.language
    : "en-US";

  return (
    <aside className="w-64 shrink-0 border-r border-[var(--border-subtle)] py-8 pr-4">
      <div className="sticky top-[76px] space-y-5">
        {/* 搜索框（sidebar 顶部） */}
        <div className="px-0">
          <DocsSearch />
        </div>

        <nav className="space-y-7">
          {sidebar.map((group) => {
            // 该分组下是否有激活项 —— 决定组标题是否高亮
            const hasActive = group.items.some((i) => i.slug === activeSlug);
            return (
              <div key={group.title}>
                <h3
                  className={cn(
                    "text-[11px] font-semibold uppercase tracking-[0.12em] mb-2.5 px-3 flex items-center gap-2",
                    hasActive
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-tertiary)]",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block w-[3px] h-3.5 rounded-full",
                      hasActive
                        ? "bg-[var(--text-primary)]"
                        : "bg-[var(--border-subtle)]",
                    )}
                    aria-hidden
                  />
                  {group.title}
                </h3>
                <ul className="space-y-0.5">
                  {group.items.map((item, idx) => {
                    // 无 slug 的条目 = 分组表头。
                    // 两种形态：
                    //   a) 纯标题：不可点击（没有 defaultChildSlug）
                    //   b) 可点击表头：点击跳转到 defaultChildSlug（如"配置通道" → 微信）
                    // 两种形态都与其它一级项（配置模型/配置技能）平级 —— 同字号、同字色、同高度
                    if (item.slug === null) {
                      // 下方紧跟的 indent 子项里若有激活的，表头也跟着高亮（表明"你在这个分组里"）
                      const childrenActive = group.items
                        .slice(idx + 1)
                        .filter((x) => x.indent)
                        .some((x) => x.slug === activeSlug);

                      const headingClass = cn(
                        "flex items-center gap-2 px-3 py-1.5 text-sm rounded-md select-none transition-colors",
                        childrenActive
                          ? "font-semibold text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)]",
                      );
                      const bullet = (
                        <span
                          className="inline-block w-1 h-1 rounded-full shrink-0 opacity-0"
                          aria-hidden
                        />
                      );

                      // 可点击表头：跳转到默认子项（不加灰底激活态，避免和子项灰底重复）
                      if (item.defaultChildSlug) {
                        return (
                          <li key={`heading-${item.title}`}>
                            <Link
                              to={localizedPath(`/docs/${item.defaultChildSlug}`, locale)}
                              className={cn(
                                headingClass,
                                !childrenActive &&
                                  "hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]",
                              )}
                            >
                              {bullet}
                              <span className="truncate">{item.title}</span>
                            </Link>
                          </li>
                        );
                      }

                      // 纯标题型表头
                      return (
                        <li key={`heading-${item.title}`}>
                          <div className={cn(headingClass, "cursor-default")}>
                            {bullet}
                            <span className="truncate">{item.title}</span>
                          </div>
                        </li>
                      );
                    }

                    const isActive = activeSlug === item.slug;
                    return (
                      <li key={item.slug}>
                        <Link
                          to={localizedPath(`/docs/${item.slug}`, locale)}
                          className={cn(
                            "flex items-center gap-2 py-1.5 text-sm rounded-md transition-colors",
                            // 二级项只用左内边距缩进，去掉竖线，保持与普通项同样的轻盈
                            item.indent ? "pl-7 pr-3" : "px-3",
                            isActive
                              ? "font-semibold text-[var(--text-primary)] bg-[var(--surface-muted)]"
                              : "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]",
                          )}
                        >
                          <span
                            className={cn(
                              "inline-block w-1 h-1 rounded-full shrink-0 transition-opacity",
                              isActive
                                ? "bg-[var(--text-primary)] opacity-100"
                                : "opacity-0",
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{item.title}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
