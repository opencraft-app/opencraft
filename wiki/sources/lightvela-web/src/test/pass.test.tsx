import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import SlideCanvas from '../components/SlideCanvas';
import { content, pages, supplements, pageFromHash } from '../deck';
import type { RichNode } from '../types';

const textOf = (node: RichNode): string => (node.text ?? '') + (node.children ?? []).map(textOf).join('');
const getText = (id: string): string => {
  const page = [...pages, ...supplements].find((p) => p.id === id)!;
  return page.elements.map((e) => e.contentKey && content[e.contentKey]).filter((n): n is RichNode => Boolean(n && 'tag' in n)).map(textOf).join('');
};
const current = pages.find((p) => p.id === 's11')!;

describe('两站注册与Pass转化更新', () => {
  it('第13页数据保持不变，正文新增画像为33页，六个最新数字全部显示', () => {
    expect(pages).toHaveLength(33); expect(current.number).toBe(13);
    expect(current.title).toBe('国内站注册更多，Pass 开通率低于国际站');
    render(<SlideCanvas page={current} content={content} />);
    ['89,122', '25,218', '17,807', '14,036', '开通率 28.3%', '开通率 78.8%', '国内站', '国际站', '13 / 33'].forEach((term) => expect(screen.getByText(term)).toBeInTheDocument());
  });
  it('比例取一位小数，差异按百分点表达', () => {
    expect((25218 / 89122 * 100).toFixed(1)).toBe('28.3');
    expect((14036 / 17807 * 100).toFixed(1)).toBe('78.8');
    expect(getText('s11')).toContain('50.5 个百分点');
    expect(getText('s11')).not.toContain('低 50.5%');
  });
  it('两条基准等长且已开通长度对应比例，分别位于本站卡片', () => {
    const el = (id: string) => current.elements.find((e) => e.attrs.id === id)!;
    const domesticBase = el('domestic-pass-base'); const overseasBase = el('international-pass-base');
    expect(domesticBase.attrs.width).toBe('531'); expect(overseasBase.attrs.width).toBe('531');
    expect(Number(el('domestic-pass-converted').attrs.width) / Number(domesticBase.attrs.width)).toBeCloseTo(0.283, 6);
    expect(Number(el('international-pass-converted').attrs.width) / Number(overseasBase.attrs.width)).toBeCloseTo(0.788, 6);
    expect(el('domestic-pass-converted').attrs.x).toBe(domesticBase.attrs.x);
    expect(el('international-pass-converted').attrs.x).toBe(overseasBase.attrs.x);
    expect(getText('s11').match(/本站累计注册 = 100%/g)).toHaveLength(2);
  });
  it('免费领取、实名观察与归因边界清楚，不混成付费转化或旧用户规模', () => {
    const text = getText('s11');
    ['国内站即使提供免费体验', '目前观察，实名验证环节带来了用户流失', '尚未完成分步漏斗归因', '全部差距不直接归因于实名', '含免费领取', '与付费及当前生效套餐口径不同'].forEach((term) => expect(text).toContain(term));
    ['3.76 万', '3.53 万', '1.48 万', '39.4%'].forEach((term) => expect(text).not.toContain(term));
  });
  it('完整旧规模仅在历史参考，定义与旧数据原样保留', () => {
    expect(supplements).toHaveLength(16);
    const history = supplements.find((p) => p.id === 'historical-scale')!;
    expect(history.group).toBe('产品现状'); expect(pages.find((p) => p.id === history.id)).toBeUndefined();
    ['3.76 万', '3.53 万', '1.48 万', '39.4%', '10 月 9 日', '唯一用户 ID 数', '与底层 CVM 数量 1:1', '包含自动任务产生的会话记录'].forEach((term) => expect(getText(history.id)).toContain(term));
  });
  it('数据页可切换历史参考并回到第13页', () => {
    window.history.replaceState(null, '', '#/s11'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '10 月 9 日历史规模与统计口径' }));
    expect(window.location.hash).toBe('#/supplements/historical-scale');
    ['3.76 万', '3.53 万', '1.48 万', '39.4%'].forEach((term) => expect(within(screen.getByRole('dialog')).getByText(term)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(window.location.hash).toBe('#/s11'); expect(screen.getByRole('article')).toHaveAttribute('data-slide-id', 's11');
  });
  it('历史参考直达链接归入产品现状，正文s11始终定位最新数据', () => {
    expect(pageFromHash('#/s11')).toBe(12);
    expect(pageFromHash('#/supplements/historical-scale')).toBe(9);
    window.history.replaceState(null, '', '#/supplements/historical-scale'); render(<App />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(window.location.hash).toBe('#/s15');
  });
});
