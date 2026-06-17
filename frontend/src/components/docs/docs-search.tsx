/**
 * 文档站全局搜索（Command Palette 风格）。
 *
 * 交互：
 * - 在顶栏放一个"搜索文档 ⌘K"的触发按钮；
 * - 全站按下 `Cmd/Ctrl + K` 或 `/`（焦点不在输入框时）打开搜索对话框；
 * - 结果列表支持 ↑ / ↓ 选择，Enter 跳转，Esc 关闭。
 *
 * 搜索策略：
 * - 索引来源 = `SIDEBAR` 每篇文档的 title + 每篇 markdown 里的 H2 标题（生成首屏目录的那一级）；
 * - 大小写不敏感 + 支持多关键词（空格分隔，全部命中即可）；
 * - Score：title 命中权重 > h2 命中权重；完全前缀匹配再加分。
 *
 * 为何不引 fuse.js：
 *   - 当前索引 ~50 条，`includes` 本就是 O(n*m) 极快；
 *   - 多加一个依赖意味着 10+ KB gzip，对这个场景不划算。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, FileText, Hash, CornerDownLeft } from "lucide-react";
import {
  SLUG_TO_FILE,
  getLocalizedSidebar,
  isEnglishLocale,
} from "@/config/docs-sidebar";
import { isGlobal, localizedPath } from "@/lib/region";
import { overlayBackdropClass } from "@/components/ui/control-shell";
import { cn } from "@/lib/utils";

// ── 索引构建 ────────────────────────────────────────────────────

/** 单条可搜索条目：文档本体（title）或文档内的某个 h2。 */
interface SearchEntry {
  kind: "doc" | "heading";
  /** 目标路由，heading 会带 `#anchor` */
  to: string;
  /** 主标题（文档 title 或 h2 文本） */
  label: string;
  /** 所属文档标题，用作次级展示 */
  docTitle: string;
  /** 所属分组标题，用作面包屑气泡 */
  groupTitle: string;
  /** 小写形式缓存，避免每次输入都 toLowerCase */
  lcLabel: string;
  lcDocTitle: string;
}

// 直接从 raw markdown 里抽 h2，避免引入 docs-loader 的重处理路径。
const markdownModules = import.meta.glob("/src/content/docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 从 markdown 原文里拎出 h2 标题（跳过代码块）。 */
function extractH2(md: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) out.push(m[1].replace(/[#*`]/g, "").trim());
  }
  return out;
}

/** GitHub 风格 slug（与 rehype-slug 基本一致，用来拼 heading 锚点）。 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 只构建一次，生命周期为模块级别。 */
function buildIndex(locale?: string): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const sidebar = getLocalizedSidebar(locale);
  const useEnglish = isEnglishLocale(locale);
  /* 国际站：搜索结果跳转 URL 也带 `/en` `/zh` 前缀（与侧边栏 / 上下篇保持一致）。
     国内站：localizedPath 是 identity，无影响。 */
  const i18nLocale: "zh-CN" | "en-US" =
    locale === "zh-CN" || locale === "en-US" ? locale : "en-US";
  for (const group of sidebar) {
    for (const item of group.items) {
      // 跳过没有对应文档的分组表头（如"配置通道"）
      if (item.slug === null) continue;
      const to = localizedPath(`/docs/${item.slug}`, i18nLocale);
      entries.push({
        kind: "doc",
        to,
        label: item.title,
        docTitle: item.title,
        groupTitle: group.title,
        lcLabel: item.title.toLowerCase(),
        lcDocTitle: item.title.toLowerCase(),
      });

      const filePath = SLUG_TO_FILE[item.slug];
      // 路径解析与 docs-loader.ts 对齐：
      //   - 国内站 (isCN)：              docs/<file>
      //   - 国际站 (isGlobal) + 英文：   docs/en/<file>
      //   - 国际站 (isGlobal) + 中文：   docs/global/<file>
      // 严格区分语言/区域：缺失时不 fallback 到其他语言/区域，避免搜索结果
      // 出现"标题英文 + 章节中文"等混杂。仅打 warn 提醒维护者补齐。
      let tryKey: string | null = null;
      if (filePath) {
        if (isGlobal) {
          tryKey = useEnglish
            ? `/src/content/docs/en/${filePath}`
            : `/src/content/docs/global/${filePath}`;
        } else {
          tryKey = `/src/content/docs/${filePath}`;
        }
      }
      const tryKeys = tryKey ? [tryKey] : [];

      let raw: string | undefined;
      for (const k of tryKeys) {
        if (markdownModules[k]) {
          raw = markdownModules[k];
          break;
        }
      }
      if (!raw) {
        if (filePath && tryKey && import.meta.env.DEV && (useEnglish || isGlobal)) {
          // 仅在国际站 / 英文环境 + 开发模式下提醒，避免线上控制台噪音
          console.warn(
            `[docs-search] missing markdown for slug "${item.slug}" ` +
              `(expected ${tryKey}); ` +
              `section index skipped to avoid mixed-language/region results.`,
          );
        }
        continue;
      }

      for (const h of extractH2(raw)) {
        entries.push({
          kind: "heading",
          to: `${to}#${slugify(h)}`,
          label: h,
          docTitle: item.title,
          groupTitle: group.title,
          lcLabel: h.toLowerCase(),
          lcDocTitle: item.title.toLowerCase(),
        });
      }
    }
  }
  return entries;
}

// ── 搜索打分 ────────────────────────────────────────────────────

/**
 * 对 query 和 entry 打分，0 表示不命中（过滤掉）。
 * query 空格分词后要求每个 token 至少命中 label/docTitle 之一。
 */
function scoreEntry(entry: SearchEntry, tokens: string[]): number {
  let score = 0;
  for (const t of tokens) {
    const hitLabel = entry.lcLabel.includes(t);
    const hitDoc = entry.lcDocTitle.includes(t);
    if (!hitLabel && !hitDoc) return 0;
    if (hitLabel) score += entry.lcLabel.startsWith(t) ? 4 : 2;
    if (hitDoc) score += 1;
  }
  // doc 本体命中略高于 heading，避免目录淹没主文档
  if (entry.kind === "doc") score += 0.5;
  return score;
}

/** 取分 > 0 的条目，按分降序取前 N 条。 */
function runSearch(query: string, searchIndex: SearchEntry[], limit = 20): SearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored = searchIndex.map((e) => ({ e, s: scoreEntry(e, tokens) })).filter(
    (x) => x.s > 0,
  );
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.e);
}

// ── 组件 ────────────────────────────────────────────────────────

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const isEnglish = isEnglishLocale(i18n.language);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const searchIndex = useMemo(() => buildIndex(i18n.language), [i18n.language]);
  const results = useMemo(() => runSearch(query, searchIndex), [query, searchIndex]);

  // 全局热键：Cmd/Ctrl+K 或 `/`（焦点不在可编辑元素时）打开
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.key === "/" && !isEditable && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 打开时重置 query / 选中项；关闭时延迟清一下
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // 等 Dialog 渲染后再 focus
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // results 变化时，activeIdx 收敛到 [0, len-1]
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results, activeIdx]);

  const go = (entry: SearchEntry) => {
    setOpen(false);
    // 用 setTimeout 让 Dialog 先关，避免 scroll 被 overlay 拦截
    window.setTimeout(() => navigate(entry.to), 20);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) =>
        results.length ? (i - 1 + results.length) % results.length : 0,
      );
    } else if (e.key === "Enter") {
      const target = results[activeIdx];
      if (target) {
        e.preventDefault();
        go(target);
      }
    }
  };

  // 高亮命中片段
  const highlight = (text: string) => {
    const q = query.trim();
    if (!q) return text;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return text;
    // 按首个 token 做一次高亮即可，简单稳妥
    const first = tokens[0];
    if (!first) return text;
    const idx = text.toLowerCase().indexOf(first.toLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-transparent font-semibold text-[var(--text-primary)]">
          {text.slice(idx, idx + first.length)}
        </mark>
        {text.slice(idx + first.length)}
      </>
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full inline-flex items-center gap-2 h-9 pl-3 pr-2 rounded-lg",
          "border border-[var(--border-subtle)] bg-[var(--surface-muted)]",
          "text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
          "hover:border-[var(--border-strong)] transition-colors",
        )}
        aria-label={isEnglish ? "Search Doc" : "搜索文档"}
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 text-left truncate">{isEnglish ? "Search Doc…" : "搜索文档…"}</span>
        <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-white text-[10px] font-mono text-[var(--text-tertiary)] shrink-0">
          ⌘K
        </kbd>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={overlayBackdropClass} />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className={cn(
              "fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2",
              "rounded-xl border border-[var(--border-subtle)] bg-white shadow-2xl overflow-hidden",
              "flex flex-col",
            )}
          >
            <DialogPrimitive.Title className="sr-only">{isEnglish ? "Search Doc" : "搜索文档"}</DialogPrimitive.Title>

            {/* 输入区 */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
              <Search className="size-4 text-[var(--text-tertiary)] shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder={isEnglish ? "Search doc titles or sections…" : "搜索文档标题或章节…"}
                className="flex-1 bg-transparent outline-none text-sm placeholder:text-[var(--text-tertiary)]"
              />
              <kbd className="hidden sm:inline-flex px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[10px] font-mono text-[var(--text-tertiary)]">
                Esc
              </kbd>
            </div>

            {/* 结果区 */}
            <div className="max-h-[60vh] overflow-y-auto">
              {query.trim() === "" ? (
                <EmptyHint locale={i18n.language} />
              ) : results.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-tertiary)]">
                  {isEnglish ? "No matching docs found" : "没有找到匹配的文档"}
                </div>
              ) : (
                <ul ref={listRef} className="py-1">
                  {results.map((r, i) => {
                    const isActive = i === activeIdx;
                    return (
                      <li key={`${r.to}-${i}`}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveIdx(i)}
                          onClick={() => go(r)}
                          className={cn(
                            "w-full flex items-center gap-3 px-4 py-2 text-left",
                            isActive && "bg-[var(--surface-muted)]",
                          )}
                        >
                          {r.kind === "doc" ? (
                            <FileText className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                          ) : (
                            <Hash className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-[var(--text-primary)] truncate">
                              {highlight(r.label)}
                            </div>
                            <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                              {r.groupTitle}
                              {r.kind === "heading" && (
                                <>
                                  <span className="mx-1">›</span>
                                  {r.docTitle}
                                </>
                              )}
                            </div>
                          </div>
                          {isActive && (
                            <CornerDownLeft className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* 页脚快捷键提示 */}
            <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--border-subtle)] bg-[var(--surface-muted)] text-[11px] text-[var(--text-tertiary)]">
              <span className="inline-flex items-center gap-1">
                <KbdMini>↑</KbdMini>
                <KbdMini>↓</KbdMini>
                {isEnglish ? "Select" : "选择"}
              </span>
              <span className="inline-flex items-center gap-1">
                <KbdMini>↵</KbdMini>
                {isEnglish ? "Go" : "跳转"}
              </span>
              <span className="inline-flex items-center gap-1">
                <KbdMini>esc</KbdMini>
                {isEnglish ? "Close" : "关闭"}
              </span>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function KbdMini({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-[var(--border-subtle)] bg-white text-[10px] font-mono">
      {children}
    </kbd>
  );
}

/** 未输入时的首屏提示 —— 简略分组罗列，便于浏览式进入。 */
function EmptyHint({ locale }: { locale?: string }) {
  const sidebar = getLocalizedSidebar(locale);
  /* 与 buildIndex 一致：国际站为本地化提示链接补齐 `/en` `/zh` 前缀。 */
  const i18nLocale: "zh-CN" | "en-US" =
    locale === "zh-CN" || locale === "en-US" ? locale : "en-US";
  return (
    <div className="py-2">
      {sidebar.map((group) => (
        <Fragment key={group.title}>
          <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            {group.title}
          </div>
          <ul>
            {group.items
              .filter((item) => item.slug !== null)
              .map((item) => (
                <li key={item.slug}>
                  <a
                    href={localizedPath(`/docs/${item.slug}`, i18nLocale)}
                    className="flex items-center gap-3 px-4 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]"
                  >
                    <FileText className="size-3.5 text-[var(--text-tertiary)]" />
                    {item.title}
                  </a>
                </li>
              ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}
