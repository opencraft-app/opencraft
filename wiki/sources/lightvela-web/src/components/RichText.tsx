import { createElement, type ReactNode } from 'react';
import { textStyle } from '../theme';
import type { RichNode } from '../types';

const tags = new Set(['p', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'sup', 'sub', 'span']);

export function richText(node: RichNode, onNavigate?: (id: string) => void, key = 'root'): ReactNode {
  const children: ReactNode[] = [];
  if (node.text) children.push(node.text);
  node.children?.forEach((child, i) => children.push(richText(child, onNavigate, `${key}_${i}`)));
  if (node.tag === 'plain') return node.text ?? '';
  if (node.tag === 'a') {
    const target = node.attrs.slide;
    const href = target ? `#/${target}` : node.attrs.href;
    const external = !!href && /^https?:\/\//.test(href);
    return (
      <a key={key} href={href} style={textStyle(node.attrs)}
        target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
        onClick={target && onNavigate ? (event) => { event.preventDefault(); onNavigate(target); } : undefined}>
        {children}
      </a>
    );
  }
  if (node.tag === 'text' || node.tag === 'td') return <div key={key} className="rich-content">{children}</div>;
  if (!tags.has(node.tag)) return <span key={key}>{children}</span>;
  return createElement(node.tag, { key, style: textStyle(node.attrs) }, children);
}
