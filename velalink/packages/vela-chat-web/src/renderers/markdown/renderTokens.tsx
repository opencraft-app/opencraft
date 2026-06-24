import type { ReactNode } from "react";
import type { Token, Tokens } from "marked";

import styles from "../../styles/desktop.module.css";
import {
  renderFadingText,
  type SegmentFadeOptions,
  type SegmentFadeTimeline,
} from "./segmentFade";

export type MarkedToken = Token;

export interface RenderMarkdownTokensOptions extends SegmentFadeOptions {
  timeline?: SegmentFadeTimeline | null;
}

export function renderMarkdownTokens(
  tokens: readonly MarkedToken[],
  options: RenderMarkdownTokensOptions = {},
): ReactNode {
  return tokens.map((token, index) => renderBlockToken(token, `md:${index}`, options));
}

function renderBlockToken(
  token: MarkedToken,
  key: string,
  options: RenderMarkdownTokensOptions,
): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return (
        <p key={key}>{renderInlineTokens((token as Tokens.Paragraph).tokens, `${key}:p`, options)}</p>
      );
    case "text":
      return <p key={key}>{renderTextToken(token as Tokens.Text, key, options)}</p>;
    case "heading":
      return renderHeadingToken(token as Tokens.Heading, key, options);
    case "blockquote":
      return <blockquote key={key}>{renderMarkdownTokens((token as Tokens.Blockquote).tokens, options)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "code":
      return renderCodeToken(token as Tokens.Code, key);
    case "list":
      return renderListToken(token as Tokens.List, key, options);
    case "table":
      return renderTableToken(token as Tokens.Table, key, options);
    case "html":
      return (token as Tokens.HTML).block ? <p key={key}>{(token as Tokens.HTML).text}</p> : (token as Tokens.HTML).text;
    default:
      return null;
  }
}

function renderInlineToken(
  token: MarkedToken,
  key: string,
  options: RenderMarkdownTokensOptions,
): ReactNode {
  switch (token.type) {
    case "text":
    case "escape":
      return renderTextToken(token as Tokens.Text | Tokens.Escape, key, options);
    case "strong":
      return <strong key={key}>{renderInlineTokens((token as Tokens.Strong).tokens, `${key}:strong`, options)}</strong>;
    case "em":
      return <em key={key}>{renderInlineTokens((token as Tokens.Em).tokens, `${key}:em`, options)}</em>;
    case "del":
      return <del key={key}>{renderInlineTokens((token as Tokens.Del).tokens, `${key}:del`, options)}</del>;
    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link":
      return renderLinkToken(token as Tokens.Link, key, options);
    case "image":
      return renderImageToken(token as Tokens.Image, key);
    case "html":
      return (token as Tokens.HTML).text;
    default:
      return null;
  }
}

function renderInlineTokens(
  tokens: readonly MarkedToken[] | undefined,
  keyPrefix: string,
  options: RenderMarkdownTokensOptions,
) {
  return (tokens ?? []).map((token, index) =>
    renderInlineToken(token, `${keyPrefix}:${index}`, options),
  );
}

function renderTextToken(
  token: Tokens.Text | Tokens.Escape,
  keyPrefix: string,
  options: RenderMarkdownTokensOptions,
) {
  if ("tokens" in token && token.tokens?.length) {
    return renderInlineTokens(token.tokens, `${keyPrefix}:nested`, options);
  }
  return renderFadingText(token.text, keyPrefix, options);
}

function renderHeadingToken(
  token: Tokens.Heading,
  key: string,
  options: RenderMarkdownTokensOptions,
) {
  const children = renderInlineTokens(token.tokens, `${key}:h`, options);
  switch (token.depth) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    default:
      return <h6 key={key}>{children}</h6>;
  }
}

export function renderCodeToken(token: Tokens.Code, key: string) {
  const language = normalizeLanguage(token.lang);
  return (
    <pre key={key}>
      <code className={language ? `language-${language}` : undefined}>
        {trimTrailingCodeNewline(token.text)}
      </code>
    </pre>
  );
}

function renderListToken(
  token: Tokens.List,
  key: string,
  options: RenderMarkdownTokensOptions,
) {
  const children = token.items.map((item, index) => (
    <li className={item.task ? styles.markdownTaskListItem : undefined} key={`${key}:item:${index}`}>
      {item.task ? (
        <input
          checked={Boolean(item.checked)}
          className={styles.markdownTaskCheckbox}
          disabled
          readOnly
          type="checkbox"
        />
      ) : null}
      <span>{renderMarkdownTokens(item.tokens, options)}</span>
    </li>
  ));

  return token.ordered ? (
    <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>
      {children}
    </ol>
  ) : (
    <ul key={key}>{children}</ul>
  );
}

export function renderTableToken(
  token: Tokens.Table,
  key: string,
  options: RenderMarkdownTokensOptions,
) {
  return (
    <div className={styles.markdownTableScroller} key={key}>
      <table className={styles.markdownTable}>
        <thead className={styles.markdownTableHead}>
          <tr className={styles.markdownTableRow}>
            {token.header.map((cell, index) => (
              <th
                className={styles.markdownTableHeaderCell}
                key={`${key}:head:${index}`}
                style={tableCellStyle(cell.align)}
              >
                {renderInlineTokens(cell.tokens, `${key}:head:${index}`, options)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={styles.markdownTableBody}>
          {token.rows.map((row, rowIndex) => (
            <tr className={styles.markdownTableRow} key={`${key}:row:${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td
                  className={styles.markdownTableCell}
                  key={`${key}:row:${rowIndex}:cell:${cellIndex}`}
                  style={tableCellStyle(cell.align)}
                >
                  {renderInlineTokens(cell.tokens, `${key}:row:${rowIndex}:cell:${cellIndex}`, options)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderLinkToken(
  token: Tokens.Link,
  key: string,
  options: RenderMarkdownTokensOptions,
) {
  const href = safeHref(token.href);
  if (!href) return renderInlineTokens(token.tokens, `${key}:unsafe-link`, options);
  return (
    <a href={href} key={key} rel="noopener noreferrer" target="_blank" title={token.title ?? undefined}>
      {renderInlineTokens(token.tokens, `${key}:link`, options)}
    </a>
  );
}

function renderImageToken(token: Tokens.Image, key: string) {
  const src = safeHref(token.href, { allowDataImage: true });
  if (!src) return token.text;
  return (
    <img
      alt={token.text}
      className={styles.markdownImage}
      key={key}
      loading="lazy"
      src={src}
      title={token.title ?? undefined}
    />
  );
}

function tableCellStyle(align: Tokens.TableCell["align"]) {
  return align ? { textAlign: align } : undefined;
}

function safeHref(href: string, options: { allowDataImage?: boolean } = {}) {
  const value = href.trim();
  if (/^javascript:/i.test(value)) return null;
  if (/^data:/i.test(value)) {
    return options.allowDataImage && /^data:image\//i.test(value) ? value : null;
  }
  return value;
}

function normalizeLanguage(language: string | undefined) {
  return language?.trim().split(/\s+/)[0];
}

export function trimTrailingCodeNewline(value: string) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}
