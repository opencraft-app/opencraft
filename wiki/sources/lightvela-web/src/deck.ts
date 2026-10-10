import pageData from './data/layouts.json';
import supplementData from './data/supplements.json';
import contentData from './data/content.json';
import type { ContentMap, SlidePage, SupplementPage } from './types';

export const pages = pageData as unknown as SlidePage[];
export const supplements = supplementData as unknown as SupplementPage[];
export const content = contentData as unknown as ContentMap;
export const sections = [
  { name: '开场', range: [1, 2] },
  { name: '出圈回顾', range: [3, 5] },
  { name: '个人助理产品洞察', range: [6, 9] },
  { name: '产品现状', range: [10, 19] },
  { name: '产品演进', range: [20, 30] },
  { name: '增长与运营', range: [31, 31] },
  { name: '核数规模估算', range: [32, 32] },
  { name: '下一阶段', range: [33, 33] },
];
export const recapPageIds = new Set(['s03', 's06', 's07']);
export const insightPageIds = new Set(['insight01', 'insight02', 'insight03', 'insight04']);
export const productPageIds = new Set(['s15', 'app01', 'visual01', 's11', 'profile01', 's12', 's13', 's14', 's08', 'focus01']);
export const evolutionPageIds = new Set(['evo01', 'evo02', 'infra00', 'infra01', 'infra02', 'infra03', 'infra04', 'infra05', 'infra06', 'infra07', 'evo03']);
const groupOpening: Record<string, string> = { '出圈回顾': 's03', '个人助理产品洞察': 'insight01', '产品现状': 's15', '产品演进': 'evo01', '核数规模估算': 'capacity01' };

export function supplementEntry(pageId: string) {
  if (pageId === 'profile01') return supplements.find((item) => item.id === 'domestic-profile') ?? null;
  const group = recapPageIds.has(pageId) ? '出圈回顾' : insightPageIds.has(pageId) ? '个人助理产品洞察' : productPageIds.has(pageId) ? '产品现状' : evolutionPageIds.has(pageId) ? '产品演进' : pageId === 'capacity01' ? '核数规模估算' : null;
  return group ? supplements.find((item) => item.group === group) ?? null : null;
}

export function supplementFromHash(hash: string) {
  const id = hash.replace(/^#\/?/, '').replace(/^supplements\//, '');
  return supplements.find((page) => page.id === id)?.id ?? null;
}

export function pageFromHash(hash: string) {
  const id = hash.replace(/^#\/?/, '');
  const index = pages.findIndex((page) => page.id === id);
  if (index >= 0) return index;
  const referenceId = supplementFromHash(hash);
  const reference = supplements.find((item) => item.id === referenceId);
  if (reference?.id === 'domestic-profile') return pages.findIndex((page) => page.id === 'profile01');
  return reference ? pages.findIndex((page) => page.id === (groupOpening[reference.group] ?? 's03')) : 0;
}

export const clampPage = (index: number) => Math.min(pages.length - 1, Math.max(0, index));
