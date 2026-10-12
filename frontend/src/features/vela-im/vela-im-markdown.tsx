import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";

/** Chat text keeps single line breaks, which Markdown would fold; fenced code is left untouched. */
const keepLineBreaks = (text: string) =>
  text.split(/(```[\s\S]*?(?:```|$))/g).map((part, index) => (index % 2 ? part : part.replace(/([^\n])\n(?!\n)/g, "$1  \n"))).join("");

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
      : node && typeof node === "object" && "props" in node ? textOf((node as { props: { children?: ReactNode } }).props.children) : "";

function CodeBlock({ children }: { children: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(textOf(children).replace(/\n$/, "")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group/code relative my-2">
      <pre className="overflow-x-auto rounded-lg bg-black/[0.04] p-3 text-[13px] leading-5">{children}</pre>
      <button type="button" onClick={copy} aria-label={t("复制代码")}
        className="absolute right-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-md bg-white/80 text-black/50 opacity-0 transition-opacity hover:text-black/80 focus-visible:opacity-100 group-hover/code:opacity-100">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--brand,#4f46e5)] underline underline-offset-2 break-all">{children}</a>,
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => <p className="mb-1 mt-2 text-base font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mb-1 mt-2 text-[15px] font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mb-1 mt-2 font-semibold first:mt-0">{children}</p>,
  h4: ({ children }) => <p className="mb-1 mt-2 font-semibold first:mt-0">{children}</p>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-black/15 pl-3 text-black/60">{children}</blockquote>,
  hr: () => <hr className="my-2 border-black/10" />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-black/[0.06] px-1 py-0.5 text-[0.9em]">{children}</code>,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-[13px]">{children}</table></div>,
  th: ({ children }) => <th className="border border-black/10 bg-black/[0.03] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-black/10 px-2 py-1 align-top">{children}</td>,
  img: ({ src, alt }) => (typeof src === "string" && /^https:\/\//.test(src)
    ? <img src={src} alt={alt ?? ""} className="my-1 max-h-64 max-w-full rounded-lg" loading="lazy" />
    : <span>{alt}</span>),
};

/** Message text as GitHub-flavoured Markdown. Raw HTML is never rendered: messages come from other people and Agents. */
export function VelaImMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("break-words text-[14px] leading-6", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{keepLineBreaks(text)}</ReactMarkdown>
    </div>
  );
}
