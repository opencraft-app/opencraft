import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import SlideCanvas from '../components/SlideCanvas';
import { content, pages, supplements, sections, clampPage, pageFromHash, supplementFromHash } from '../deck';
import type { RichNode } from '../types';

function nodeText(node: RichNode): string { return (node.text ?? '') + (node.children ?? []).map(nodeText).join(''); }
function pageText(id: string) {
  const page = [...pages, ...supplements].find((item) => item.id === id);
  return page?.elements.map((el) => el.contentKey && content[el.contentKey]).filter((data): data is RichNode => Boolean(data && 'tag' in data)).map(nodeText).join('') ?? '';
}

describe('文稿内容完整性', () => {
  it('31页正文顺序准确，所有正文和补充内容引用可解析', () => {
    expect(pages).toHaveLength(31);
    expect(pages.map((p) => p.id)).toEqual(['s01', 's02', 's03', 's06', 's07', 'insight01', 'insight02', 'insight03', 'insight04', 's15', 'app01', 'visual01', 's11', 's12', 's13', 's14', 's08', 'focus01', 'evo01', 'evo02', 'infra00', 'infra01', 'infra02', 'infra03', 'infra04', 'infra05', 'infra06', 'infra07', 'evo03', 's21', 's24']);
    pages.forEach((page, i) => expect(page.number).toBe(i + 1));
    [...pages, ...supplements].forEach((page) => page.elements.forEach((el) => { if (el.contentKey) expect(content[el.contentKey]).toBeDefined(); }));
  });
  it('出圈回顾仅三页，阶段判断归入产品现状', () => {
    expect(pages.filter((page) => page.section.startsWith('01 出圈回顾')).map((p) => p.id)).toEqual(['s03', 's06', 's07']);
    expect(pages[16].id).toBe('s08');
    expect(pages[16].section).toBe('03 产品现状 · 阶段判断');
    expect(sections.find((s) => s.name === '出圈回顾')?.range).toEqual([3, 5]);
  });
  it('新品牌形象仅用于封面、目录和封底', () => {
    const brandPages = [...pages, ...supplements].filter((page) => page.elements.some((el) => {
      const data = el.contentKey && content[el.contentKey];
      return data && 'src' in data && data.src.includes('_trim.png');
    })).map((page) => page.id);
    expect(brandPages).toEqual(['s01', 's02', 's24']);
  });
  it.each([...pages, ...supplements].map((p) => [p.id, p] as const))('%s 的文字和表格内容在 HTML 中完整保留', (_, page) => {
    const { container } = render(<SlideCanvas page={page} content={content} />);
    const normalize = (t: string) => t.replace(/\s/g, '');
    page.elements.forEach((el) => {
      const data = el.contentKey && content[el.contentKey];
      if (data && 'tag' in data && ['text', 'table'].includes(el.type)) expect(normalize(container.textContent ?? '')).toContain(normalize(nodeText(data)));
    });
  });
  it('三项动作准确，不将邀请活动写成临时策划', () => {
    const text = pageText('s03');
    expect(text).toContain('X 官方发声');
    expect(text).toContain('邀请送积分同步开放');
    expect(text).toContain('原计划的好友邀请活动上线');
    expect(text).toContain('免费体验一个月');
    expect(text).toContain('邀请双方均可获得 AI 积分');
  });
  it('媒体扩散突出标签来源和范围，不展示2万或10万阅读量', () => {
    const text = pageText('s06');
    expect(text).toContain('人人都是产品经理');
    expect(text).toContain('“中国版 Muse”引发多账号跟进传播');
    expect(text).toContain('多个公众号集中跟进');
    expect(text).not.toMatch(/2\s*万|10\s*万/);
  });
  it('图表读取原始值，不重算未满100%的场景比例', () => {
    const charts = Object.values(content).filter((data): data is RichNode => 'tag' in data && data.tag === 'chart');
    expect(charts.map((chart) => chart.children?.[0].attrs.values)).toEqual(['251,177,117,111,101,65,15', '8212,6575,5078,2641', '27.8,16.1,8.5']);
  });
  it('所有页面均无指定AI式衔接句', () => {
    const text = Object.values(content).filter((n): n is RichNode => 'tag' in n).map(nodeText).join('');
    expect(text).not.toContain('不是'); expect(text).not.toContain('而是');
  });
  it('首页不显示已删除说明，自动页脚与正文页数一致', () => {
    render(<SlideCanvas page={pages[0]} content={content} />);
    expect(screen.queryByText('LightVela｜依据原始汇报材料整理；数据截至 10 月 9 日，另有说明除外')).not.toBeInTheDocument();
    expect(screen.getByText('01 / 31')).toBeInTheDocument();
    pages.forEach((p) => expect(pageText(p.id)).toContain(`${String(p.number).padStart(2, '0')} / 31`));
  });
  it('目录保留指定文案并更新传播回顾描述', () => {
    render(<SlideCanvas page={pages[1]} content={content} />);
    expect(screen.queryByText('沿用原始材料的叙事顺序，先看增长，再看使用和产品方向。')).not.toBeInTheDocument();
    expect(screen.getByText('定位、App、新视觉、使用反馈与场景选择')).toBeInTheDocument();
    expect(screen.getByText('泛开发者、产品亮点、基础设施与体验')).toBeInTheDocument();
    expect(screen.getByText('三项动作、媒体扩散与增长结果')).toBeInTheDocument();
  });
  it('目录05增长运营与03产品现状卡片保持等宽左对齐', () => {
    const elements = pages[1].elements;
    const card03 = elements.find((el) => el.type === 'shape' && el.attrs.type === 'rect' && el.attrs.x === '40' && el.attrs.y === '348');
    const card05 = elements.find((el) => el.type === 'shape' && el.attrs.type === 'rect' && el.attrs.x === '40' && el.attrs.y === '502');
    expect(card03).toBeDefined(); expect(card05).toBeDefined();
    expect(card05?.attrs.width).toBe(card03?.attrs.width); expect(card05?.attrs.width).toBe('575');
  });
  it('完整保留三张国内公众号图和前期材料，不进入正文页数', () => {
    expect(supplements.map((p) => p.id)).toEqual(['recap-background', 's04', 's05', 's22', 's23', 's09', 's10', 'product-comparison', 'historical-scale', 's16', 's17', 's18', 's19', 's20']);
    const archive = supplements.find((p) => p.id === 's04')!;
    const images = archive.elements.filter((el) => el.type === 'image');
    expect(images.map((el) => el.contentKey && content[el.contentKey]).filter((data) => data && 'src' in data).map((data) => data && 'src' in data ? data.src : '')).toEqual([
      '/assets/source_01.png', '/assets/source_03.png', '/assets/source_05.png', '/assets/source_06.png', '/assets/source_07.png', '/assets/source_08.png',
    ]);
    render(<SlideCanvas page={archive} content={content} onImage={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: '放大原始截图' })).toHaveLength(6);
  });
  it('产品洞察四页在产品现状之前，五个正文章节完整', () => {
    expect(pages.slice(5, 9).map((p) => p.id)).toEqual(['insight01', 'insight02', 'insight03', 'insight04']);
    expect(pages[9].id).toBe('s15');
    expect(sections.find((s) => s.name === '个人助理产品洞察')?.range).toEqual([6, 9]);
    expect(sections.find((s) => s.name === '产品现状')?.range).toEqual([10, 18]);
    expect(sections.find((s) => s.name === '产品演进')?.range).toEqual([19, 29]);
    expect(sections.find((s) => s.name === '补充材料')).toBeUndefined();
  });
  it('4–5月上线及个人助理定位完整，海外日期沿用原文', () => {
    const text = pageText('insight01');
    ['4–5 月', 'LightVela 上线', '定位：个人助理', '08.11', '08.26', '09.08', '09.28', '09.29', 'Grok Bot', 'Instinct', 'Meta Muse', 'Manus Cue', 'OpenAI Dot'].forEach((term) => expect(text).toContain(term));
    expect(text).not.toMatch(/2026\.0[45]\.\d{2}/);
  });
  it('Muse七类场景图完整显示原始案例数、占比和口径', () => {
    render(<SlideCanvas page={pages[6]} content={content} />);
    const chart = screen.getByRole('img');
    ['个人事务与效率 251 条 · 30.0%', '财务与省钱 177 条 · 21.1%', '购物、餐饮与活动 117 条 · 14.0%', '工作、内容与开发 111 条 · 13.3%', '旅行与出行 101 条 · 12.1%', '健康、家庭、学习与休闲 65 条 · 7.8%', '产品设置或任务不明 15 条 · 1.8%'].forEach((label) => expect(chart).toHaveAccessibleName(expect.stringContaining(label)));
    expect(pageText('insight02')).toContain('非活跃用户分布');
    expect(pageText('insight02')).toContain('按案例需求归纳适用人群');
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
  it('海外热度与能力限制清晰，详细模型分数只在参考中', () => {
    ['用户容易看懂', '任务有落地条件', '关注得到集中放大', '未测量各因素的增长贡献'].forEach((term) => expect(pageText('insight03')).toContain(term));
    ['持久记忆', '定时任务', '子 Agent', 'MCP', '模型和配置', '高风险个人事务'].forEach((term) => expect(pageText('insight04')).toContain(term));
    expect(pageText('insight04')).not.toContain('50.7%');
    ['50.7%', '46.4%', '48.1%', '37.1%', '837'].forEach((term) => expect(pageText('s23')).toContain(term));
    expect(pageText('s22')).toContain('微信小微');
  });
  it('一页讲清定制化、IM入口和独立多Bot，不扩成三页', () => {
    expect(pages[9].title).toBe('LightVela：可按需定制的云端个人助理');
    expect(pages.slice(9, 18).map((p) => p.id)).toEqual(['s15', 'app01', 'visual01', 's11', 's12', 's13', 's14', 's08', 'focus01']);
    ['定制化', '入口灵活', '多 Bot', '网页打磨，IM 接收', '微信、Telegram', '也可日常对话', 'Hermes 原生能力', '独立个性', '记忆和工作空间'].forEach((term) => expect(pageText('s15')).toContain(term));
    expect(pageText('s15')).not.toMatch(/唯一支持|全部不支持|自动协同已/);
    expect(pageText('s08')).not.toContain('独立站覆盖 Agent 创建与配置、多 Bot、通道、技能和定时任务');
  });
  it('产品路径、配置、实验室与原友商比较完整保留在参考', () => {
    expect(pageText('s09')).toContain('订阅 / 免费体验');
    ['DeepSeek Harness', '个人工作台', '9 月基于 Hermes 原生能力上线'].forEach((term) => expect(pageText('s10')).toContain(term));
    ['Meta Muse', 'OpenAI Dot', 'Instinct / Manus Cue', '海外优先验证', '国内持续打磨'].forEach((term) => expect(pageText('product-comparison')).toContain(term));
    expect(supplements.filter((p) => p.group === '产品现状')).toHaveLength(4);
  });
  it('演进三页与基础设施资料衔接，聚焦泛开发者，硬件同级而多云降为参考', () => {
    expect(pages.filter((p) => p.id.startsWith('evo')).map((p) => p.id)).toEqual(['evo01', 'evo02', 'evo03']);
    ['聚焦泛开发者场景', 'AI 建站与云端应用', '多 Agent 协作', '硬件开发与接入', '屏幕、按钮、摄像头', '低成本接入实验'].forEach((term) => expect(pageText('evo01')).toContain(term));
    ['evo01', 'evo02', 'evo03'].forEach((id) => expect(pageText(id)).not.toContain('多云资源管理'));
    expect(pageText('s17')).toContain('多云资源管理');
    expect(sections.find((s) => s.name === '增长与运营')?.range).toEqual([30, 30]);
    expect(sections.find((s) => s.name === '下一阶段')?.range).toEqual([31, 31]);
  });
  it('能力亮点与体验明确，当前基础与探索不混写', () => {
    ['多 Bot', '云电脑', '硬件生态', '协同执行继续探索', '执行范围仍需补齐', 'API、SDK、MCP', '设备 ↔ 云端 Agent'].forEach((term) => expect(pageText('evo02')).toContain(term));
    ['拟人化', '主动性', '交互视觉更新', '授权范围内', '重要操作继续确认', '主动性仍为研究方向', '角色识别 · 状态反馈 · 操作确认'].forEach((term) => expect(pageText('evo03')).toContain(term));
    expect(pageText('evo03')).not.toMatch(/主动性已上线|成熟硬件生态/);
  });
  it('演进原五页完整保留，架构、多云、身份、接口和三张体验图均在参考', () => {
    expect(supplements.filter((p) => p.group === '产品演进').map((p) => p.id)).toEqual(['s16', 's17', 's18', 's19', 's20']);
    expect(pageText('s16')).toContain('不代表 LightVela 当前实现');
    ['专属邮箱', 'Agent 钱包', '私有 NAS'].forEach((term) => expect(pageText('s18')).toContain(term));
    expect(pageText('s19')).toContain('ESP32');
    const page = supplements.find((p) => p.id === 's20')!;
    expect(page.elements.filter((e) => e.type === 'image').map((e) => (content[e.contentKey!] as { src: string }).src)).toEqual(['/assets/source_33.png', '/assets/source_34.png', '/assets/source_35.png']);
  });
  it('官网新视觉已上线置于App路线之后，原数据仍完整连续', () => {
    expect(pages[11].id).toBe('visual01');
    expect(pages.slice(12, 16).map((p) => p.id)).toEqual(['s11', 's12', 's13', 's14']);
    ['官网首页已上线首版新视觉', '可信赖、亲和、灵动', '官网当前首页', '新视觉演示 · 中文版', '设计目标', '产品内交互视觉后续继续优化'].forEach((term) => expect(pageText('visual01')).toContain(term));
    expect(pageText('visual01')).not.toMatch(/转化率提升|留存提升|全面上线/);
    expect(pages[28].title).toBe('持续优化产品交互，完善角色识别与任务反馈');
    ['Bot 切换', '执行状态', '授权确认', '异常反馈', '后续产品内交互优化'].forEach((term) => expect(pageText('evo03')).toContain(term));
  });
  it('视频源与真实首帧是同源数据，仅新增现状页含视频', () => {
    const mediaPages = [...pages, ...supplements].filter((p) => p.elements.some((e) => e.type === 'video'));
    expect(mediaPages.map((p) => p.id)).toEqual(['visual01']);
    const node = mediaPages[0].elements.find((e) => e.type === 'video')!;
    expect(content[node.contentKey!]).toEqual({ src: '/assets/lightvela-homepage-visual-demo.mp4', poster: '/assets/lightvela-homepage-video-poster.png', title: 'LightVela 新视觉演示 · 中文版', duration: 37.8 });
    const { container } = render(<SlideCanvas page={mediaPages[0]} content={content} />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByAltText('LightVela 新视觉演示 · 中文版')).toHaveAttribute('src', '/assets/lightvela-homepage-video-poster.png');
  });
  it('演进前场景选择仅一页，三类任务及选择理由都有原文依据', () => {
    const page = pages.find((p) => p.id === 'focus01')!;
    expect(page.number).toBe(18);
    expect(pages.slice(16, 19).map((p) => p.id)).toEqual(['s08', 'focus01', 'evo01']);
    expect(page.section).toBe('03 产品现状 · 场景选择');
    const text = pageText('focus01');
    ['优先服务泛开发者', '用户和任务更熟悉', '已有能力更匹配', '结果可检查', '搭建并持续维护自己的工具', '按职能组织持续工作的流程', '连接自己的服务、工具和设备', '个人工作台已在实验室上线', '独立多 Bot 已上线', 'DeepSeek Harness 为实验入口', '协同继续探索', '屏幕、按钮、摄像头', '标准接口与设备接入继续探索', '外部操作仍需授权', '非用户职业分布'].forEach((term) => expect(text).toContain(term));
    expect(text).not.toMatch(/多云资源管理|多数用户|留存提升|成熟自动协作|全面上线/);
    expect(page.elements.some((e) => ['image', 'video'].includes(e.type))).toBe(false);
  });
  it('App路线一页包含三项依据，规划与现有Web/IM明确分开', () => {
    const page = pages.find((p) => p.id === 'app01')!;
    expect(page.number).toBe(11);
    expect(page.title).toBe('优先做移动 App，承接离开电脑后的个人事务');
    const text = pageText('app01');
    ['个人事务碎片化', '待确认事项和异常情况', '执行留在云端', '桌面客户端无需前置', '本地文件和系统控制权限', '邮箱、账户等服务仍按需授权', '语音、相机与分享入口', '位置和联系人按需授权', '执行记录和审批', '微信、Telegram', '现有 Web / IM', '优先移动 App', '按需补充桌面客户端', '多窗口研究', '产品路线，未标为 App 已上线'].forEach((term) => expect(text).toContain(term));
    expect(text).not.toMatch(/App 已正式上线|获客成本降低|全部个人权限|已接入支付/);
    expect(page.elements.some((e) => ['image', 'video'].includes(e.type))).toBe(false);
    render(<SlideCanvas page={page} content={content} />);
    expect(screen.getByRole('link', { name: 'Muse 云端执行、移动入口与授权机制参考' })).toHaveAttribute('href', 'https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/');
  });

});

describe('演示交互', () => {
  it('左上角使用提供的Logo', () => {
    render(<App />);
    const logo = within(screen.getByRole('banner')).getByRole('img', { name: 'LightVela Logo' });
    expect(logo).toHaveAttribute('src', '/assets/lightvela-logo.png');
    expect(logo).toHaveAttribute('width', '32'); expect(logo).toHaveAttribute('height', '32');
  });
  it('按钮键盘翻页按新正文顺序前进', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/s02');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/s03');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/s06');
    fireEvent.keyDown(window, { key: 'End' }); expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Home' }); expect(window.location.hash).toBe('#/s01');
  });
  it('目录页仍能跳转到产品现状', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '目录页' })); fireEvent.click(screen.getByRole('link', { name: '产品现状' }));
    expect(window.location.hash).toBe('#/s15');
  });
  it('搜索时不触发快捷键', () => {
    render(<App />); const search = screen.getByRole('textbox', { name: '搜索页面' });
    fireEvent.change(search, { target: { value: '国内站' } }); fireEvent.keyDown(search, { key: 'ArrowRight' });
    expect(screen.getByRole('article')).toHaveAttribute('data-slide-id', 's01');
    expect(screen.getByRole('button', { name: /13 国内站注册更多，Pass 开通率低于国际站/ })).toBeInTheDocument();
  });
  it('总览仅包含31页正文', () => {
    window.history.replaceState(null, '', '#/s11'); render(<App />); fireEvent.click(screen.getByRole('button', { name: '总览' }));
    const grid = screen.getByLabelText('页面总览'); expect(within(grid).getAllByRole('button')).toHaveLength(31);
    fireEvent.click(within(grid).getAllByRole('button')[30]); expect(window.location.hash).toBe('#/s24');
  });
  it('全屏按钮调用浏览器API', () => {
    const request = vi.fn().mockResolvedValue(undefined); HTMLElement.prototype.requestFullscreen = request;
    render(<App />); fireEvent.click(screen.getByRole('button', { name: /全屏演示/ })); expect(request).toHaveBeenCalledOnce();
  });
  it('正文摘图打开完整原图', () => {
    window.history.replaceState(null, '', '#/s03'); render(<App />); fireEvent.click(screen.getByRole('button', { name: '放大原始截图' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_11.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/s03');
  });
  it('补充材料可切换、放大图片、返回材料及主文稿', () => {
    window.history.replaceState(null, '', '#/s03'); render(<App />); fireEvent.click(screen.getByRole('button', { name: '补充材料' }));
    let modal = screen.getByRole('dialog'); expect(modal).toHaveAttribute('aria-label', '出圈回顾补充材料');
    fireEvent.click(within(modal).getByRole('button', { name: '前期账号与公众号截图' }));
    expect(window.location.hash).toBe('#/supplements/s04');
    fireEvent.click(within(modal).getAllByRole('button', { name: '放大原始截图' })[4]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_07.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); modal = screen.getByRole('dialog');
    expect(modal).toHaveAttribute('aria-label', '出圈回顾补充材料');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/supplements/s04');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/s03');
  });
  it.each(['#/s04', '#/s05', '#/supplements/s04'])('旧或补充链接%s直接打开保留资料', (hash) => {
    window.history.replaceState(null, '', hash); render(<App />); expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '出圈回顾补充材料');
    expect(pageFromHash(hash)).toBe(2); expect(supplementFromHash(hash)).not.toBeNull();
  });
  it('目录能够跳转到前置的产品洞察', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '目录页' }));
    fireEvent.click(screen.getByRole('link', { name: '个人助理产品洞察' }));
    expect(window.location.hash).toBe('#/insight01');
  });
  it('产品洞察的详细参考独立分组，关闭返回原正文', () => {
    window.history.replaceState(null, '', '#/insight04'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    let modal = screen.getByRole('dialog');
    expect(modal).toHaveAttribute('aria-label', '个人助理产品洞察补充材料');
    expect(within(modal).queryByRole('button', { name: '前期账号与公众号截图' })).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Muse 原始场景表与 Hermes 能力' }));
    expect(window.location.hash).toBe('#/supplements/s23');
    modal = screen.getByRole('dialog'); expect(within(modal).getByText('50.7%')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: '关闭弹窗' }));
    expect(window.location.hash).toBe('#/insight04');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each(['#/s22', '#/s23', '#/supplements/s23'])('原附录链接%s打开详细参考并落在新章节', (hash) => {
    window.history.replaceState(null, '', hash); render(<App />);
    expect(pageFromHash(hash)).toBe(5);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '个人助理产品洞察补充材料');
  });
  it('结果页翻到产品洞察，第四页洞察接到产品现状', () => {
    window.history.replaceState(null, '', '#/s07'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/insight01');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/insight02');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(window.location.hash).toBe('#/insight04');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/s15');
  });
  it('产品现状参考分组可切换，关闭返回定位页', () => {
    window.history.replaceState(null, '', '#/s15'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    let modal = screen.getByRole('dialog'); expect(modal).toHaveAttribute('aria-label', '产品现状补充材料');
    expect(within(modal).queryByRole('button', { name: '市场玩家与国内潜在竞品' })).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: '配置能力、多 Bot 与实验室' }));
    expect(window.location.hash).toBe('#/supplements/s10');
    fireEvent.click(within(modal).getByRole('button', { name: '友商比较与市场验证重点' }));
    modal = screen.getByRole('dialog'); expect(within(modal).getByText('海外优先验证')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/s15');
  });
  it.each(['#/s09', '#/s10', '#/supplements/product-comparison'])('产品旧链接%s打开原资料并落在定位页', (hash) => {
    window.history.replaceState(null, '', hash); render(<App />);
    expect(pageFromHash(hash)).toBe(9); expect(supplementFromHash(hash)).not.toBeNull();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/s15');
  });
  it('定位页摘图打开完整原始配置或多Bot界面', () => {
    window.history.replaceState(null, '', '#/s15'); render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '放大原始截图' })[0]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_26.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    fireEvent.click(screen.getAllByRole('button', { name: '放大原始截图' })[1]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_27.png');
  });
  it('目录演进入口经能力、八页基础设施和体验后接增长运营', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '目录页' }));
    fireEvent.click(screen.getByRole('link', { name: '产品演进' })); expect(window.location.hash).toBe('#/evo01');
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/evo02');
    for (let i = 0; i < 8; i++) { fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe(`#/infra0${i}`); }
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/evo03');
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/s21');
  });
  it('演进详细参考独立分组，可切换后返回当前正文', () => {
    window.history.replaceState(null, '', '#/evo02'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    let modal = screen.getByRole('dialog'); expect(modal).toHaveAttribute('aria-label', '产品演进补充材料');
    expect(within(modal).queryByRole('button', { name: '独立站使用全流程' })).not.toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: '完整场景与通用执行能力' }));
    modal = screen.getByRole('dialog'); expect(within(modal).getByText('多云资源管理')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/evo02');
  });
  it.each(['#/s16', '#/s17', '#/s18', '#/s19', '#/s20', '#/supplements/s20'])('演进旧链接%s打开完整原材料', (hash) => {
    window.history.replaceState(null, '', hash); render(<App />);
    expect(pageFromHash(hash)).toBe(18); expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品演进补充材料');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/evo01');
  });
  it('体验摘图可打开完整角色对话和外部参考原图', () => {
    window.history.replaceState(null, '', '#/evo03'); render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: '放大原始截图' })[0]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_35.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    fireEvent.click(screen.getAllByRole('button', { name: '放大原始截图' })[1]);
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/source_33.png');
  });
  it('定位之后进入App路线、新视觉，再进入原规模数据页', () => {
    window.history.replaceState(null, '', '#/s15'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/app01');
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/visual01');
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/s11');
  });
  it('App直接链接、参考返回和前后翻页指向正确正文', () => {
    window.history.replaceState(null, '', '#/app01'); render(<App />);
    expect(pageFromHash('#/app01')).toBe(10);
    expect(screen.getByRole('article')).toHaveAttribute('data-slide-id', 'app01');
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/app01');
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(window.location.hash).toBe('#/s15');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/app01');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/visual01');
  });
  it('搜索App路线能跳转到新增第11页', () => {
    render(<App />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索页面' }), { target: { value: '移动 App' } });
    fireEvent.click(screen.getByRole('button', { name: /11 优先做移动 App/ }));
    expect(window.location.hash).toBe('#/app01');
  });
  it('阶段判断接场景选择再到演进，参考返回不丢失落点', () => {
    window.history.replaceState(null, '', '#/s08'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '下一页' })); expect(window.location.hash).toBe('#/focus01');
    expect(pageFromHash('#/focus01')).toBe(17);
    fireEvent.click(screen.getByRole('button', { name: '详细参考' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '配置能力、多 Bot 与实验室' }));
    expect(window.location.hash).toBe('#/supplements/s10');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(window.location.hash).toBe('#/focus01');
    fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(window.location.hash).toBe('#/evo01');
    fireEvent.keyDown(window, { key: 'ArrowLeft' }); expect(window.location.hash).toBe('#/focus01');
  });
  it('搜索场景选择能跳转到第18页', () => {
    render(<App />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索页面' }), { target: { value: '优先服务泛开发者' } });
    fireEvent.click(screen.getByRole('button', { name: /18 优先服务泛开发者/ }));
    expect(window.location.hash).toBe('#/focus01');
  });
  it('视频可手动控制，弹窗不会触发翻页，Esc关闭停止播放', () => {
    window.history.replaceState(null, '', '#/visual01'); const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '播放LightVela 新视觉演示 · 中文版' }));
    const modal = screen.getByRole('dialog', { name: '新视觉演示视频' }); expect(modal).toHaveAttribute('open');
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('src', '/assets/lightvela-homepage-visual-demo.mp4');
    expect(video).toHaveAttribute('controls'); expect(video).toHaveAttribute('playsinline'); expect(video).not.toHaveAttribute('autoplay');
    [' ', 'ArrowRight', 'Home', 'End'].forEach((key) => fireEvent.keyDown(video, { key })); expect(window.location.hash).toBe('#/visual01');
    const stop = vi.spyOn(video, 'pause'); fireEvent.keyDown(window, { key: 'Escape' });
    expect(stop).toHaveBeenCalledOnce(); expect(container.querySelector('video')).toBeNull(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('视频错误提示和重新打开可用，关闭按钮或页面导航卸载媒体', () => {
    window.history.replaceState(null, '', '#/visual01'); const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '播放LightVela 新视觉演示 · 中文版' }));
    const video = container.querySelector('video')!; fireEvent.error(video);
    expect(screen.getByRole('status')).toHaveTextContent('视频暂时无法加载');
    const stop = vi.spyOn(video, 'pause'); fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' })); expect(stop).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '播放LightVela 新视觉演示 · 中文版' })); expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const nextVideo = container.querySelector('video')!; const nextStop = vi.spyOn(nextVideo, 'pause');
    window.history.replaceState(null, '', '#/s11'); fireEvent(window, new Event('hashchange'));
    expect(nextStop).toHaveBeenCalledOnce(); expect(container.querySelector('video')).toBeNull();
  });
  it('新视觉页官网截图打开真实完整首屏，详细参考仍在现状分组', () => {
    window.history.replaceState(null, '', '#/visual01'); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '放大原始截图' }));
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', '/assets/lightvela-homepage-current-full.png');
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    fireEvent.click(screen.getByRole('button', { name: '详细参考' })); expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', '产品现状补充材料');
  });
  it('无效页码与hash回落到边界', () => {
    expect(clampPage(-1)).toBe(0); expect(clampPage(99)).toBe(30); expect(pageFromHash('#/invalid')).toBe(0);
  });
});
