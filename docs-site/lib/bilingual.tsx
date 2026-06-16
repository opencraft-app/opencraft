import type * as PageTree from 'fumadocs-core/page-tree';
import type { ReactNode } from 'react';

import { source } from '@/lib/source';

export function bilingualText(en: string | undefined, zh: string | undefined, fallback: ReactNode) {
  if (!en || !zh) return fallback;

  return (
    <>
      <span className="lang-en">{en}</span>
      <span className="lang-zh">{zh}</span>
    </>
  );
}

function splitBilingualName(value: ReactNode): ReactNode {
  if (typeof value !== 'string') return value;

  const parts = value.split(' / ');
  if (parts.length !== 2) return value;

  return bilingualText(parts[0], parts[1], value);
}

function slugFromRef(ref: string): string[] | undefined {
  const withoutExtension = ref.replace(/\.mdx$/, '');
  const normalized = withoutExtension === 'index' ? '' : withoutExtension.replace(/\/index$/, '');
  if (!normalized) return undefined;

  return normalized.split('/');
}

function localizeNode(node: PageTree.Node): PageTree.Node {
  if (node.type === 'page') {
    const page = node.$ref ? source.getPage(slugFromRef(node.$ref)) : undefined;

    return {
      ...node,
      name: page ? bilingualText(page.data.title_en, page.data.title_zh, node.name) : splitBilingualName(node.name),
      description: page
        ? bilingualText(page.data.description_en, page.data.description_zh, node.description)
        : splitBilingualName(node.description),
    };
  }

  if (node.type === 'folder') {
    return {
      ...node,
      name: splitBilingualName(node.name),
      description: splitBilingualName(node.description),
      index: node.index ? (localizeNode(node.index) as PageTree.Item) : undefined,
      children: node.children.map(localizeNode),
    };
  }

  return {
    ...node,
    name: splitBilingualName(node.name),
  };
}

export function localizedPageTree(tree: PageTree.Root): PageTree.Root {
  return {
    ...tree,
    name: splitBilingualName(tree.name),
    description: splitBilingualName(tree.description),
    children: tree.children.map(localizeNode),
  };
}
