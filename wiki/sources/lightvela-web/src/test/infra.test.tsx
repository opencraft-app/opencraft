import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import DynamicSlide, { makeInfraDocument } from '../components/DynamicSlide';
import template from '../data/infra-template.html?raw';
import { content, pages } from '../deck';

const config = { pageIndex: 3, number: 24, total: 31, token: 'test-token', parentOrigin: 'http://localhost:3000', static: false, manual: false };
function getToken(frame: HTMLIFrameElement) { return JSON.parse(frame.srcdoc.match(/const EMBED = (.*);/)![1]).token as string; }
function send(frame: HTMLIFrameElement, action: string, extra = {}, options: { token?: string; origin?: string; source?: Window | null } = {}) {
  fireEvent(window, new MessageEvent('message', { source: options.source === undefined ? frame.contentWindow : options.source, origin: options.origin ?? 'null', data: { type: 'lightvela-infra', token: options.token ?? getToken(frame), action, ...extra } }));
}

describe('基础设施8页完整动画', () => {
  it('8个稳定ID按原顺序加入正文21–28页，原参考不替换', () => {
    const dynamic = pages.filter((p) => p.id.startsWith('infra'));
    expect(dynamic.map((p) => p.id)).toEqual(Array.from({ length: 8 }, (_, i) => `infra0${i}`));
    expect(dynamic.map((p) => p.number)).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
    dynamic.forEach((p, i) => {
      const e = p.elements.find((n) => n.type === 'dynamic')!;
      expect(content[e.contentKey!]).toEqual({ pageIndex: i, title: p.title });
    });
    expect(pages[28].id).toBe('evo03'); expect(pages[29].id).toBe('s21'); expect(pages[30].id).toBe('s24');
  });
  it('完整8个section、原SVG与动画定义均保留', () => {
    expect(template.match(/<section class="slide/g)).toHaveLength(8);
    expect(template.match(/<animateMotion/g)).toHaveLength(8);
    ['@keyframes rvIn', '@keyframes dash', '@keyframes shake', '@keyframes spin', '@keyframes pulse', '@keyframes flash', '@keyframes breath', 'const ACTS', 'fastForward()', 'class="tabs"', 'beginElement()', 'c.fly(', 'c.move(', 'c.bar('].forEach((term) => expect(template).toContain(term));
  });
  it('POC实测、样本量待补、验证中与目标标签完整保留', () => {
    ['20–49 秒', '3.5 秒', '1.5 秒', '16 秒', '10 秒', '样本量待补', '端到端未完整计时', '目标 · 正在验证，尚无实测', '调研设计 · 未实测', '已跑通 POC', '大脑与工作台分离'].forEach((term) => expect(template).toContain(term));
    expect(template).toContain("sandbox: ''"); expect(template).toContain("failover: ''");
  });
  it('白底文字和SVG同时适配，红绿琥珀状态与品牌紫仍区分', () => {
    ['html, body, .deck { background: #fff; }', '--text: #1d1d1f', '--cyan: #6842ff', '--green: #17805b', '--amber: #956009', '--red: #ce3450', '--purple: #7651d9'].forEach((term) => expect(template).toContain(term));
    expect(template).not.toContain('#0a0e16'); expect(template).not.toContain('#e6edf7');
  });
  it('生成配置支持指定单页、全局页码和静态终态，不留模板标识', () => {
    const doc = makeInfraDocument(config);
    expect(doc).toContain('"pageIndex":3'); expect(doc).toContain('"number":24'); expect(doc).toContain('"total":31');
    expect(doc).not.toContain('__LV_EMBED_CONFIG__'); expect(doc).toContain('go(EMBED.pageIndex)');
    expect(doc).toContain('.static *, .static *::before');
    expect(makeInfraDocument({ ...config, static: true, manual: true })).toContain('"static":true');
  });
  it('隔离动态页面，不授予主站权限或网络访问', () => {
    const { container } = render(<DynamicSlide data={{ pageIndex: 3, title: '方案一' }} number={24} total={31} staticPreview={false} paused={false} onAction={vi.fn()} />);
    const frame = container.querySelector('iframe')!;
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts'); expect(frame).not.toHaveAttribute('src');
    expect(frame.srcdoc).toContain("connect-src 'none'"); expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).not.toContain('localStorage.setItem'); expect(frame.srcdoc).not.toContain('history.replaceState');
  });
  it('总览只生成静态终态，禁用iframe点击，不执行全局导航', () => {
    const action = vi.fn(); const { container } = render(<DynamicSlide data={{ pageIndex: 7, title: '管家' }} number={28} total={31} staticPreview={true} paused={false} onAction={action} />);
    const frame = container.querySelector('iframe')!;
    expect(frame).toHaveStyle({ pointerEvents: 'none' }); expect(frame).toHaveAttribute('tabindex', '-1'); expect(frame.srcdoc).toContain('"static":true');
    send(frame, 'navigate', { delta: 1 }); expect(action).not.toHaveBeenCalled();
  });
  it('只接收当前opaque iframe及匹配令牌的有限导航消息', () => {
    const action = vi.fn(); const { container } = render(<DynamicSlide data={{ pageIndex: 3, title: '方案一' }} number={24} total={31} staticPreview={false} paused={false} onAction={action} />);
    const frame = container.querySelector('iframe')!;
    send(frame, 'navigate', { delta: 1 }, { token: 'wrong' });
    send(frame, 'navigate', { delta: 1 }, { source: window });
    send(frame, 'navigate', { delta: 1 }, { origin: window.location.origin });
    send(frame, 'navigate', { delta: 9 }); send(frame, 'key', { key: 'delete' });
    expect(action).not.toHaveBeenCalled();
    send(frame, 'navigate', { delta: 1 }); expect(action).toHaveBeenLastCalledWith({ action: 'navigate', delta: 1 });
    send(frame, 'edge', { edge: 'last' }); expect(action).toHaveBeenLastCalledWith({ action: 'edge', edge: 'last' });
    send(frame, 'key', { key: 'f' }); expect(action).toHaveBeenLastCalledWith({ action: 'key', key: 'f' });
  });
  it('主站R/M/N传入重播、模式和分段控制，卸载发送暂停', () => {
    const { container, unmount } = render(<DynamicSlide data={{ pageIndex: 3, title: '方案一' }} number={24} total={31} staticPreview={false} paused={false} onAction={vi.fn()} />);
    const frame = container.querySelector('iframe')!; const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    ['r', 'm', 'n'].forEach((key) => fireEvent.keyDown(window, { key }));
    expect(post.mock.calls.map(([data]) => data.action)).toEqual(['replay', 'mode', 'advance']);
    unmount(); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pause' }), '*');
  });
  it('弹窗暂停动态播放器，关闭重新进入当前页，模式在父页保存', () => {
    const action = vi.fn(); const props = { data: { pageIndex: 3, title: '方案一' }, number: 24, total: 31, staticPreview: false, onAction: action };
    const { container, rerender } = render(<DynamicSlide {...props} paused={false} />);
    const frame = container.querySelector('iframe')!; const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    send(frame, 'ready', { pageIndex: 3 });
    rerender(<DynamicSlide {...props} paused={true} />); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pause' }), '*');
    rerender(<DynamicSlide {...props} paused={false} />); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'resume' }), '*');
    send(frame, 'mode', { manual: true }); expect(sessionStorage.getItem('lightvela-infra-mode')).toBe('manual'); sessionStorage.removeItem('lightvela-infra-mode');
  });
  it('iframe翻页交给文稿，离开后卸载旧帧，跨章节无双翻', () => {
    window.history.replaceState(null, '', '#/infra07'); const { container } = render(<App />);
    const frame = container.querySelector('iframe')!; send(frame, 'navigate', { delta: 1 });
    expect(window.location.hash).toBe('#/evo03'); expect(container.querySelector('iframe')).toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(window.location.hash).toBe('#/infra07');
    const next = container.querySelector('iframe')!; expect(next).not.toBe(frame);
    send(next, 'edge', { edge: 'last' }); expect(window.location.hash).toBe('#/s24');
  });
  it('动态页全屏与详细参考均复用主文稿控制', () => {
    window.history.replaceState(null, '', '#/infra03'); const { container } = render(<App />);
    const request = vi.fn().mockResolvedValue(undefined); HTMLElement.prototype.requestFullscreen = request;
    const frame = container.querySelector('iframe')!; send(frame, 'key', { key: 'f' }); expect(request).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品演进补充材料');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/infra03');
  });
});
