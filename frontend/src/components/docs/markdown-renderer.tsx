/**
 * 文档 Markdown 渲染器。
 *
 * 渲染管线严格对齐 LightVela-Docs 原实现：
 *   - remark-gfm    → GFM 扩展（表格、任务列表、删除线…）
 *   - rehype-raw    → 让 `fixBoldBoundary` 塞进去的 <strong> 原样生效
 *   - rehype-slug   → 自动给 h2/h3/h4 生成 id，方便锚点 / TOC 跳转
 *
 * 自定义组件：
 *   - blockquote → 识别 Callout（info/tip/warn）并使用 lucide 图标
 *   - pre + code → 带语言的走 react-syntax-highlighter（one-light 主题）；
 *                 不带语言的由 pre 提供统一外框
 *   - a          → 内部 /docs 链接走 react-router <Link>
 *   - input      → GFM 任务列表的复选框改成黑色风格
 *
 * 视觉样式由 `.prose-doc` 前缀的 CSS 规则承载（见 styles.css），与 LightVela-Docs
 * 一致，保证"严格遵守现在的渲染模式"。
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import type { TocItem } from "@/components/docs/docs-toc";

/** 从 ReactNode 里抽出纯文本，用于生成锚点 id / 判定 Callout 类型。 */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/**
 * 判定 blockquote 的 Callout 类型：
 * - ⚠️ / warning / 警告 / 注意 → warn
 * - 💡 / tip / 提示 / 小技巧 → tip
 * - ℹ️ / info / note → info
 * - 其他 → 默认 blockquote
 *
 * 注意：图标不再由组件绘制，由用户在 md 原文自己打（比如直接写 ⚠️）；
 * 这里只是根据"开头有没有这些关键词"决定 callout 配色。
 */
function detectCallout(text: string): "info" | "tip" | "warn" | null {
  const head = text.slice(0, 40);
  if (/⚠️|warning|警告/i.test(head)) return "warn";
  if (/💡|tip|提示|小技巧/i.test(head)) return "tip";
  if (/ℹ️|info|note|^注:/i.test(head)) return "info";
  return null;
}

const CALLOUT_STYLE = {
  info: { background: "#F0F9FF", borderColor: "#BAE6FD", color: "#0C4A6E" },
  tip: { background: "#F0FDF4", borderColor: "#BBF7D0", color: "#14532D" },
  warn: { background: "#FFFBEB", borderColor: "#FDE68A", color: "#78350F" },
} as const;

/**
 * 带语言标签 + 复制按钮的代码块。
 * 头部左侧是胶囊式语言徽章，右侧是 hover 才显现的"复制"按钮，
 * 复制成功后切换为 Check 图标 + "已复制"提示，1.6s 后复原。
 */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 浏览器拒绝写剪贴板时静默失败（比如 http 环境、权限未授予）
    }
  };

  return (
    <div className="group my-5 rounded-lg overflow-hidden border border-[var(--border-subtle)] bg-[#FAFAFA]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white border-b border-[var(--border-subtle)]">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-[var(--surface-muted)] text-[11px] font-mono text-[var(--text-tertiary)] tracking-wide">
          {lang}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity px-2 py-1 rounded-md hover:bg-[var(--surface-muted)]"
          aria-label="复制代码"
        >
          {copied ? (
            <>
              <Check size={12} strokeWidth={2.5} className="text-[var(--text-primary)]" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneLight as Record<string, React.CSSProperties>}
        customStyle={{
          margin: 0,
          padding: "1rem",
          background: "#FAFAFA",
          fontSize: "13px",
          lineHeight: 1.6,
        }}
        codeTagProps={{ style: { fontFamily: "JetBrains Mono, Menlo, monospace" } }}
        PreTag="div"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

interface MarkdownRendererProps {
  content: string;
  onTocCollected?: (toc: TocItem[]) => void;
}

export function MarkdownRenderer({ content, onTocCollected }: MarkdownRendererProps) {
  // 预扫描 markdown 生成 TOC；rehype-slug 使用相同的 slug 规则，
  // 保证 TOC 里的 id 与正文标题上的 id 匹配得上。
  const toc = useMemo(() => generateToc(content), [content]);

  useEffect(() => {
    onTocCollected?.(toc);
  }, [toc, onTocCollected]);

  const components: Components = {
    // 自定义 blockquote：识别 Callout
    blockquote({ children, ...props }) {
      const text = extractText(children as ReactNode);
      const kind = detectCallout(text);
      if (!kind) {
        return (
          <blockquote {...(props as Record<string, unknown>)}>
            {children}
          </blockquote>
        );
      }
      const style = CALLOUT_STYLE[kind];
      // 不再绘制 lucide 图标，图标交给 md 原文自己打（⚠️ / 💡 / ℹ️ 等）
      return (
        <div
          className="my-5 px-4 py-3 rounded-lg border text-[14px] [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:first-child]:mb-2 [&>p:last-child]:mb-0 [&_strong]:font-semibold"
          style={style}
        >
          {children}
        </div>
      );
    },

    // 代码块外壳（pre）：
    //   1) 带语言：内部 SyntaxHighlighter 已经提供完整容器，这里透传即可
    //   2) 不带语言：提供统一的灰底 + 圆角边框外壳
    pre({ children, ...props }) {
      const child = Array.isArray(children) ? children[0] : children;
      const childClass =
        (child as { props?: { className?: string } } | undefined)?.props?.className ?? "";
      const hasLang = /language-\w+/.test(childClass);

      if (hasLang) {
        return <>{children}</>;
      }

      return (
        <div className="my-5 rounded-lg overflow-hidden border border-gray-200 bg-[#FAFAFA]">
          <pre
            {...(props as Record<string, unknown>)}
            className="m-0 p-0 bg-transparent overflow-auto"
          >
            {children}
          </pre>
        </div>
      );
    },

    // 行内 code / 带语言的 fenced code
    code(props) {
      const { className, children, ...rest } = props as {
        className?: string;
        children?: ReactNode;
      };
      const match = /language-(\w+)/.exec(className ?? "");

      if (match) {
        const lang = match[1] ?? "text";
        const code = String(children).replace(/\n$/, "");
        return <CodeBlock lang={lang} code={code} />;
      }

      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    },

    // 链接：内部 /docs/* 走 react-router；锚点保持原生；其他开新标签页
    a({ href, children, ...props }) {
      if (!href) return <a {...props}>{children}</a>;
      if (href.startsWith("/docs")) {
        return (
          <Link to={href} className="prose-link">
            {children}
          </Link>
        );
      }
      if (href.startsWith("#")) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
          {children}
          <span className="text-gray-400">↗</span>
        </a>
      );
    },

    // GFM 任务列表复选框：黑色风格
    input(props) {
      if (props.type === "checkbox") {
        return (
          <span
            className="inline-flex items-center justify-center w-4 h-4 mr-1 rounded border align-middle -translate-y-[1px]"
            style={{
              borderColor: props.checked ? "#000" : "#D1D1D6",
              background: props.checked ? "#000" : "#fff",
            }}
          >
            {props.checked ? <Check size={12} color="#fff" strokeWidth={3} /> : null}
          </span>
        );
      }
      return <input {...props} />;
    },
  };

  return (
    <div className="prose-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSlug]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 从 markdown 原文里提取标题生成 TOC —— 只收 H2，保持"本页目录"简洁。
 * H3/H4 不纳入，否则长文档目录会很长失去导航价值。
 * 跳过 fenced code block 内的 `#` 行。
 */
function generateToc(md: string): TocItem[] {
  const toc: TocItem[] = [];
  const lines = md.split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const m = /^(##)\s+(.+?)\s*$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;

    const text = m[2].replace(/[#*`]/g, "").trim();
    const id = slugify(text);
    toc.push({ id, text, level: 2 });
  }

  return toc;
}

/**
 * 与 rehype-slug 保持一致的 slug 规则（简化版，对中文友好）。
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[（）()【】\[\]<>「」『』"'`,.!?:;，。！？：；、]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
