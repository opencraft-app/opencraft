import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import React, { Children, isValidElement, type ReactNode } from 'react';

type CalloutKind = 'info' | 'tip' | 'warn';

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return '';
}

function detectCalloutKind(text: string): CalloutKind | null {
  const head = text.trim().slice(0, 48);
  if (/^⚠️|warning|警告|注意/i.test(head)) return 'warn';
  if (/^💡|tip|提示|小技巧/i.test(head)) return 'tip';
  if (/^ℹ️|info|note|注:/i.test(head)) return 'info';
  return null;
}

const CALLOUT_ICON: Record<CalloutKind, string> = {
  info: 'ℹ️',
  tip: '💡',
  warn: '⚠️',
};

function calloutTitle(node: ReactNode): string {
  return extractText(node)
    .replace(/^\s*(ℹ️|⚠️|💡)\s*/u, '')
    .trim();
}

function splitInlineCalloutTitle(node: ReactNode): { title: string; body: ReactNode[] } {
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return { title: calloutTitle(node), body: [] };
  }

  const children = Children.toArray(node.props.children);
  const titleIndex = children.findIndex((child) => isValidElement(child) && child.type === 'strong');
  if (titleIndex < 0) {
    return { title: calloutTitle(node), body: [] };
  }

  return {
    title: extractText(children[titleIndex]),
    body: children.slice(titleIndex + 1),
  };
}

function LightVelaCallout({ children, kind }: { children: ReactNode; kind: CalloutKind }) {
  const blocks = Children.toArray(children);
  const titleBlockIndex = blocks.findIndex((block) => detectCalloutKind(extractText(block)) === kind);
  const titleBlock = titleBlockIndex >= 0 ? blocks[titleBlockIndex] : blocks[0];
  const { title, body: inlineBody } = splitInlineCalloutTitle(titleBlock);
  const body = titleBlockIndex >= 0
    ? blocks.filter((_, index) => index !== titleBlockIndex)
    : blocks.slice(1);
  if (inlineBody.length > 0) {
    body.unshift(<p key="inline-callout-body">{inlineBody}</p>);
  }

  return (
    <aside className={`lv-docs-callout lv-docs-callout--${kind}`}>
      <div className="lv-docs-callout__header">
        <span className="lv-docs-callout__icon" aria-hidden="true">
          {CALLOUT_ICON[kind]}
        </span>
        <strong className="lv-docs-callout__title">{title}</strong>
      </div>
      {body.length > 0 ? <div className="lv-docs-callout__body">{body}</div> : null}
    </aside>
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    blockquote({ children, ...props }) {
      const kind = detectCalloutKind(extractText(children));
      if (kind) {
        return <LightVelaCallout kind={kind}>{children}</LightVelaCallout>;
      }
      return <blockquote {...props}>{children}</blockquote>;
    },
    ...components,
  };
}
