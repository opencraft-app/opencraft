import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import SlideCanvas from '../components/SlideCanvas';
import { content, pages, supplements, sections, pageFromHash, supplementEntry } from '../deck';
import type { RichNode } from '../types';

const plain = (n: RichNode): string => (n.text ?? '') + (n.children ?? []).map(plain).join('');
const getText = (id: string) => [...pages, ...supplements].find((p) => p.id === id)!.elements.map((e) => e.contentKey && content[e.contentKey]).filter((n): n is RichNode => Boolean(n && 'tag' in n)).map(plain).join('');
const page = pages.find((p) => p.id === 'capacity01')!;

describe('末尾核数规模情景估算', () => {
  it('第32页位于增长之后与第33页封底之前，原8页动态按整页顺延', () => {
    expect(pages).toHaveLength(33); expect(supplements).toHaveLength(16);
    expect(pages.slice(30).map((p) => p.id)).toEqual(['s21', 'capacity01', 's24']);
    expect(page.number).toBe(32); expect(pageFromHash('#/capacity01')).toBe(31);
    expect(sections.find((s) => s.name === '核数规模估算')?.range).toEqual([32, 32]);
    expect(sections.find((s) => s.name === '下一阶段')?.range).toEqual([33, 33]);
    expect(pages.filter((p) => p.id.startsWith('infra')).map((p) => p.number)).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
  });
  it('原生表格准确对应年份、注册和核数，合计独立成列', () => {
    render(<SlideCanvas page={page} content={content} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      ['指标', '国内站', '国际站', '两站合计'],
      ['2026 年末预计注册', '约 13.8 万', '约 6.0 万', '—'],
      ['2026 年末预计核数', '17.7–18.1 万核', '14.7–15.0 万核', '32.4–33.1 万核'],
      ['2027 年末预计注册', '22–26 万', '10.8–13.2 万', '—'],
      ['2027 年末预计核数', '37.8–53.6 万核', '27.7–37.7 万核', '65.5–91.3 万核'],
    ]);
    expect(screen.getByText('32 / 33')).toBeInTheDocument();
    expect(page.elements.some((e) => ['image', 'video', 'dynamic'].includes(e.type))).toBe(false);
  });
  it('区间合计加总正确，注册近似展示符合倍数', () => {
    expect([17.7 + 14.7, 18.1 + 15].map((n) => n.toFixed(1))).toEqual(['32.4', '33.1']);
    expect([37.8 + 27.7, 53.6 + 37.7].map((n) => n.toFixed(1))).toEqual(['65.5', '91.3']);
    expect([13.8 * 1.6, 13.8 * 1.9].map((n) => Math.round(n))).toEqual([22, 26]);
    expect([6 * 1.8, 6 * 2.2].map((n) => n.toFixed(1))).toEqual(['10.8', '13.2']);
  });
  it('完整假设保留全部倍数与两年套餐占比，数据不混为已实现指标', () => {
    const text = getText('capacity-assumptions');
    ['最近 30 天 × 1.2', '最近 30 天 × 1.25', '1.6–1.9 倍', '1.8–2.2 倍', '约 5%–7.5%', '约 4%–6%', '约 8%–12%', '约 6%–10%', '相对 2026 年末', '未从底层模型独立复算全部核数', '未来开通率', '实例保留规则'].forEach((s) => expect(text).toContain(s));
    expect(getText('capacity01')).toContain('情景估算');
    expect(getText('capacity01')).toContain('同等注册规模下，国际站对应的核数需求更高');
    expect(getText('capacity01')).not.toMatch(/国际站.*增长更快|已完成核数采购/);
  });
  it('当前基线6.5/3.4与保守5.0/2.6区分事件和用户，不等同实际在用', () => {
    ['capacity01', 'capacity-assumptions'].forEach((id) => {
      const text = getText(id);
      ['6.5 万核', '3.4 万核', '5.0 万核', '2.6 万核', '重复创建', '重建', '已释放实例', '峰值并发'].forEach((s) => expect(text).toContain(s));
    });
    expect(getText('capacity-assumptions')).toContain('创建实例成功用户');
    expect(getText('capacity-assumptions')).toContain('保守参考下限');
  });
  it('增长之后可翻到估算和封底，方向键返回落点正确', () => {
    window.history.replaceState(null, '', '#/s21'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/capacity01');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/s24');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(window.location.hash).toBe('#/capacity01');
  });
  it('完整假设独立分组，关闭返回第32页且不误落到其他章节', () => {
    window.history.replaceState(null, '', '#/capacity01'); render(<App />);
    expect(supplementEntry('capacity01')?.id).toBe('capacity-assumptions');
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    const dialog = screen.getByRole('dialog', { name: '核数规模估算补充材料' });
    expect(window.location.hash).toBe('#/supplements/capacity-assumptions');
    expect(within(dialog).getByRole('button', { name: '完整增长假设与核数估算口径' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '基础设施与原架构参考' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(window.location.hash).toBe('#/capacity01');
  });
  it('假设直达与搜索入口可用，总览包括估算页不运行动态素材', () => {
    expect(pageFromHash('#/supplements/capacity-assumptions')).toBe(31);
    window.history.replaceState(null, '', '#/supplements/capacity-assumptions'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(screen.getByRole('article')).toHaveAttribute('data-slide-id', 'capacity01');
    fireEvent.click(screen.getByRole('button', { name: '总览' }));
    expect(within(screen.getByLabelText('页面总览')).getAllByRole('button')).toHaveLength(33);
    fireEvent.click(within(screen.getByLabelText('页面总览')).getAllByRole('button')[31]);
    expect(window.location.hash).toBe('#/capacity01');
  });
});
