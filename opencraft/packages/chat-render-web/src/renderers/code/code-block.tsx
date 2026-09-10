import type { ChatNodeRendererProps } from "@opencraft/chat-render-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type ReactNode,
} from "react";

import { writeTextToClipboard } from "../../clipboard";
import {
  codeBlockWrapPreference,
  codeLanguageLabel,
  isSvgCodeSnippet,
  resolveCodeSurfacePolicy,
  type CodeSurfacePolicy,
} from "./code-block-model";
import "./code-block.scss";

export { codeBlockWrapPreference, codeLanguageLabel } from "./code-block-model";

export interface CodeBlockSurfaceProps {
  readonly code: string;
  readonly language: string | null;
  readonly open?: boolean;
  readonly highlightedHtml?: string | null;
  readonly pending?: boolean;
  readonly showActions?: boolean;
  /**
   * Geometry is selected here, at the code-surface boundary. Product pages
   * must not reach into the surface and resize its private scroller.
   */
  readonly policy?: CodeSurfacePolicy;
  /** Owned by the enhancement controller; never used to mutate geometry. */
  readonly rootRef?: Ref<HTMLElement>;
  /** Explicit host capability; Codex gates this for ordinary ChatUI. */
  readonly stickyHeader?: boolean;
  readonly title?: ReactNode;
}

function svgPreviewSource(
  code: string,
  language: string | null,
  open: boolean,
): string | null {
  if (open) return null;
  if (!isSvgCodeSnippet(code, language)) return null;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code);
}

function CopyGlyph({ copied }: { readonly copied: boolean }) {
  return (
    <span
      aria-hidden
      className={copied ? "chat-code-action__check" : "chat-code-action__copy"}
    />
  );
}

export function CodeBlockSurface({
  code,
  language,
  open = false,
  highlightedHtml = null,
  pending = false,
  showActions = true,
  stickyHeader = false,
  title,
  policy,
  rootRef,
}: CodeBlockSurfaceProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const wrapPreference = useSyncExternalStore(
    codeBlockWrapPreference.subscribe,
    codeBlockWrapPreference.getSnapshot,
    codeBlockWrapPreference.getSnapshot,
  );
  useEffect(() => {
    setCopied(false);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, [code]);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );
  const copy = () => {
    void writeTextToClipboard(code)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null)
          window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(
          () => setCopied(false),
          1_500,
        );
      })
      .catch(() => setCopied(false));
  };
  const displayTitle = title ?? codeLanguageLabel(language, open);
  const svgSource = svgPreviewSource(code, language, open);
  const resolvedPolicy = policy ?? resolveCodeSurfacePolicy({ code, language });
  const wrap = resolvedPolicy.wrap === "always"
    || (resolvedPolicy.wrap === "user-controlled" && wrapPreference);
  return (
    <figure
      className="chat-code-block"
      data-code-open={open || undefined}
      data-code-pending={pending || undefined}
      data-code-sticky-header={stickyHeader || undefined}
      data-code-wrap={wrap || undefined}
      data-code-wrap-policy={resolvedPolicy.wrap}
      data-code-variant={resolvedPolicy.variant}
      data-markdown-copy="code-block"
      ref={rootRef}
      tabIndex={resolvedPolicy.variant === "preview" ? 0 : undefined}
    >
      <figcaption data-markdown-copy="exclude">
        <span className="chat-code-block__title">{displayTitle}</span>
        {showActions ? (
          <span className="chat-code-block__actions">
            {resolvedPolicy.wrap === "user-controlled" ? (
              <button
                aria-label={wrapPreference ? "Disable word wrap" : "Enable word wrap"}
                aria-pressed={wrapPreference}
                className="chat-code-action chat-code-action--wrap"
                onClick={() => codeBlockWrapPreference.toggle()}
                title={wrapPreference ? "Disable word wrap" : "Enable word wrap"}
                type="button"
              >
                <span aria-hidden>↵</span>
              </button>
            ) : null}
            {!open ? (
              <button
                aria-label={copied ? "Copied code" : "Copy code"}
                className="chat-code-action"
                onClick={copy}
                title={copied ? "Copied" : "Copy code"}
                type="button"
              >
                <CopyGlyph copied={copied} />
              </button>
            ) : null}
          </span>
        ) : null}
      </figcaption>
      <div className="chat-code-block__scroller" dir="ltr" tabIndex={0}>
        {svgSource !== null ? (
          <img
            alt="Image generated by the assistant"
            className="chat-code-block__svg"
            src={svgSource}
          />
        ) : (
          <pre>
            <code
              className={
                highlightedHtml === null ? undefined : "chat-code-highlight"
              }
              dangerouslySetInnerHTML={
                highlightedHtml === null
                  ? undefined
                  : { __html: highlightedHtml }
              }
            >
              {highlightedHtml === null ? code : undefined}
            </code>
          </pre>
        )}
      </div>
    </figure>
  );
}

export function BaseCodeBlockRenderer({
  context,
  node,
}: ChatNodeRendererProps): ReactNode {
  if (node.kind !== "code-fence") return null;
  return (
    <CodeBlockSurface
      code={node.code}
      language={node.language}
      open={node.completeness === "open"}
      stickyHeader={context.stickyCodeHeaders}
    />
  );
}
