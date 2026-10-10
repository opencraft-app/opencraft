import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import SlideCanvas from '../components/SlideCanvas';
import { content, pages, supplements, sections, pageFromHash, supplementEntry } from '../deck';
import type { RichNode } from '../types';

const page = pages.find((p) => p.id === 'profile01')!;
const reference = supplements.find((p) => p.id === 'domestic-profile')!;
const plain = (n: RichNode): string => (n.text ?? '') + (n.children ?? []).map(plain).join('');
const textOf = (id: string) => [...pages, ...supplements].find((p) => p.id === id)!.elements.map((e) => e.contentKey && content[e.contentKey]).filter((n): n is RichNode => Boolean(n && 'tag' in n)).map(plain).join('');
const chart = (id: string) => content[page.elements.find((e) => e.attrs.id === id)!.contentKey!] as RichNode;
const rows = [
  ['18岁以下', '1,691', '5.1%', '1,103', '146', '13.2%', '21.1%', '76'],
  ['18–24岁', '6,090', '18.3%', '4,320', '1,414', '32.7%', '33.3%', '1,258'],
  ['25–29岁', '5,030', '15.2%', '3,085', '1,098', '35.6%', '30.3%', '950'],
  ['30–34岁', '5,118', '15.4%', '2,995', '1,179', '39.4%', '35.3%', '1,010'],
  ['35–39岁', '5,819', '17.5%', '3,394', '1,395', '41.1%', '35.4%', '1,108'],
  ['40–44岁', '4,622', '13.9%', '2,767', '1,195', '43.2%', '37.4%', '953'],
  ['45–49岁', '2,546', '7.7%', '1,565', '659', '42.1%', '36.8%', '579'],
  ['50–59岁', '1,728', '5.2%', '1,069', '460', '43.0%', '39.4%', '338'],
  ['60岁以上', '557', '1.7%', '295', '88', '29.8%', '40.0%', '55'],
];
const number = (s: string) => Number(s.replaceAll(',', ''));

describe('国内站用户画像：只客观展示数据', () => {
  it('新增第14页位于Pass之后，33页与16份参考导航同步', () => {
    expect(pages).toHaveLength(33); expect(supplements).toHaveLength(16);
    expect(pages.slice(12, 15).map((p) => p.id)).toEqual(['s11', 'profile01', 's12']);
    expect(page.number).toBe(14); expect(page.title).toBe('国内站用户画像');
    expect(pageFromHash('#/profile01')).toBe(13);
    expect(sections.find((s) => s.name === '产品现状')?.range).toEqual([10, 19]);
    expect(page.elements.some((e) => ['image', 'video', 'dynamic'].includes(e.type))).toBe(false);
  });
  it('两个分区标题、快照与摘要数字采用用户确认用词', () => {
    render(<SlideCanvas page={page} content={content} />);
    ['国内站用户画像', '已实名账号', '开通套餐的用户画像', '33,201', '33.5 岁', '33 岁', '登记男性 85.3% · 登记女性 14.7%', '20,593', '7,634', '37.1%', '14 / 33'].forEach((s) => expect(screen.getByText(s)).toBeInTheDocument());
    expect(textOf('profile01')).toContain('2026-10-10 快照');
  });
  it('实名9年龄段人数占比沿用原图，双序列不排序或排名', () => {
    const verified = chart('verified-age'); const usage = chart('package-usage-age');
    expect(verified.attrs.categories?.split(',')).toEqual(rows.map((r) => r[0]));
    expect(verified.children![0].attrs.values?.split(',').map(Number)).toEqual(rows.map((r) => number(r[1])));
    expect(verified.children![0].attrs.percentages?.split(',')).toEqual(rows.map((r) => r[2].replace('%', '')));
    expect(usage.attrs.categories).toBe(verified.attrs.categories);
    expect(usage.children!.map((s) => s.attrs.name)).toEqual(['近7日使用率', 'D7使用留存']);
    expect(usage.children![0].attrs.values?.split(',').map(Number)).toEqual(rows.map((r) => Number(r[5].replace('%', ''))));
    expect(usage.children![1].attrs.values?.split(',').map(Number)).toEqual(rows.map((r) => Number(r[6].replace('%', ''))));
  });
  it('汇总33,201/20,593/7,634与37.1%正确，使用率取原始人数分母', () => {
    expect(rows.reduce((n, r) => n + number(r[1]), 0)).toBe(33201);
    expect(rows.reduce((n, r) => n + number(r[3]), 0)).toBe(20593);
    expect(rows.reduce((n, r) => n + number(r[4]), 0)).toBe(7634);
    expect((7634 / 20593 * 100).toFixed(1)).toBe('37.1');
    rows.forEach((r) => expect(`${(number(r[4]) / number(r[3]) * 100).toFixed(1)}%`).toBe(r[5]));
  });
  it('双横条映射50%同尺度，9组18条且无障碍标签标明各序列', () => {
    const { container } = render(<SlideCanvas page={page} content={content} />);
    const svg = screen.getAllByRole('img')[1];
    expect(svg.querySelectorAll('rect')).toHaveLength(18);
    expect(svg).toHaveAccessibleName(expect.stringContaining('18岁以下 近7日使用率 13.2%，D7使用留存 21.1%'));
    expect(svg.textContent).toContain('50%');
    const bars = Array.from(svg.querySelectorAll('rect'));
    expect(Number(bars[0].getAttribute('width')) / Number(bars[1].getAttribute('width'))).toBeCloseTo(13.2 / 21.1, 8);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
  it('完整数据表保留所有原始人数、百分比与D7独立分母', () => {
    render(<SlideCanvas page={reference} content={content} />);
    const cells = within(screen.getByRole('table')).getAllByRole('row').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(cells.slice(1)).toEqual(rows);
    expect(textOf('domestic-profile')).toContain('D7留存人数未提供');
    expect(textOf('domestic-profile')).toContain('60岁以上D7分母为55个');
  });
  it('不含评价、建议、职业推断或实付断言，统计说明明确保留', () => {
    const main = textOf('profile01'); const detail = textOf('domestic-profile');
    expect(main + detail).not.toMatch(/更活跃|表现更好|高价值|最佳人群|优先访谈|洞察|产品策略|职业|泛开发者|实付用户|41\.5%|31\.2%/);
    ['账号未按自然人去重', '收费Pass订单已开通', '含优惠', '未核验实付与退款', '使用含自动任务', '观察期已满账号'].forEach((s) => expect(main).toContain(s));
    ['历史重置', '输出 token > 0', '五个网关分片', '20,593与前页25,218统计条件不同', '不相除推导付费率', '不推定套餐样本的性别分布'].forEach((s) => expect(detail).toContain(s));
  });
  it('从Pass进入画像再到频次，前后翻页保持原页ID', () => {
    window.history.replaceState(null, '', '#/s11'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/profile01');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/s12');
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(window.location.hash).toBe('#/profile01');
  });
  it('画像参考直接打开完整原图，关闭原图与参考后返回第14页', () => {
    window.history.replaceState(null, '', '#/profile01'); render(<App />);
    expect(supplementEntry('profile01')?.id).toBe('domestic-profile');
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    expect(window.location.hash).toBe('#/supplements/domestic-profile');
    const modal = screen.getByRole('dialog', { name: '产品现状补充材料' });
    const images = within(modal).getAllByRole('button', { name: '放大原始截图' }); expect(images).toHaveLength(2);
    fireEvent.click(images[1]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/domestic-package-profile-20261010.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/profile01');
  });
  it('参考直达落在画像页，搜索与总览包含新增第14页', () => {
    expect(pageFromHash('#/supplements/domestic-profile')).toBe(13);
    window.history.replaceState(null, '', '#/supplements/domestic-profile'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/profile01');
    fireEvent.change(screen.getByRole('textbox', { name: '搜索页面' }), { target: { value: '国内站用户画像' } });
    expect(screen.getByRole('button', { name: /14 国内站用户画像/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '总览' }));
    const items = within(screen.getByLabelText('页面总览')).getAllByRole('button'); expect(items).toHaveLength(33);
    fireEvent.click(items[13]); expect(window.location.hash).toBe('#/profile01');
  });
});
