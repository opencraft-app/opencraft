import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HERMES_APPEARANCE, parseHermesAppearance, asDoodleAppearance, type HermesAppearance } from '@/lib/hermes-appearance';
import { AgentDressupStudio, HermesStepDressup } from '@/pages/marketing/agent-dressup-studio';
import { AgentDressupPreview } from '@/pages/marketing/agent-dressup-preview';

vi.mock('@/i18n/t', () => ({ useCurrentLocale: () => 'zh-CN', useT: () => (value: string) => value }));
beforeEach(() => localStorage.clear());
afterEach(() => cleanup());
function Harness({ onConfirm = () => {} }: { onConfirm?: (value: HermesAppearance) => void }) {
  const [value, setValue] = useState(DEFAULT_HERMES_APPEARANCE);
  return <AgentDressupStudio value={value} onChange={setValue} onBack={() => {}} onConfirm={onConfirm} />;
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));

describe('Hermes illustration studio', () => {
  it.each(['white', 'charcoal'] as const)('makes legacy %s visible as one selected editable colour and confirms that colour', (skin) => {
    const save = vi.fn();
    render(<AgentDressupStudio value={{ ...DEFAULT_HERMES_APPEARANCE, skin }} onChange={vi.fn()} onBack={vi.fn()} onConfirm={save} />);
    const colours = ['浅紫', '蜜桃', '奶黄', '薄荷', '晴空'].map((label) => button(label));
    expect(colours.filter((option) => option.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(button('浅紫')).toHaveAttribute('aria-pressed', 'true');
    click('就用这个');
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ skin: 'lavender', style: 'doodle' }));
  });

  it('keeps reverse click layering through color changes, toggles, confirm and saved parsing', () => {
    const save = vi.fn(); render(<Harness onConfirm={save} />);
    click('小书本'); click('星星巫师帽'); click('奶油耳机'); click('晴空');
    click('就用这个');
    const look = save.mock.lastCall![0] as HermesAppearance;
    expect(look.doodads).toEqual(['book', 'wizard-hat', 'headphones']);
    expect(asDoodleAppearance(parseHermesAppearance(JSON.parse(JSON.stringify(look)))!).doodads).toEqual(look.doodads);
    const layers = [...screen.getByLabelText('和 Hermes 打招呼').querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid'));
    expect(layers.indexOf('plush-book')).toBeLessThan(layers.indexOf('plush-wizard-hat'));
    expect(layers.indexOf('plush-wizard-hat')).toBeLessThan(layers.indexOf('plush-headphones'));
    click('星星巫师帽'); click('星星巫师帽'); click('就用这个');
    expect(save.mock.lastCall![0].doodads).toEqual(['book', 'headphones', 'wizard-hat']);
  });

  function StepHarness({ initial = { ...DEFAULT_HERMES_APPEARANCE, skin: 'mint', expression: 'wink' } as HermesAppearance }) {
    const [value, setValue] = useState<HermesAppearance>(initial);
    return <><HermesStepDressup appearance={value} onChange={setValue} zh /><output data-testid="appearance">{JSON.stringify(value)}</output></>;
  }
  const readAppearance = () => JSON.parse(screen.getByTestId('appearance').textContent!);
  const heading = (name: string) => screen.getByRole('heading', { name });
  it('starts bare and preserves colour while switching shapes before adding accessories', () => {
    render(<StepHarness />);
    heading('先选个颜色'); click('薄荷');
    click('量量');
    expect(readAppearance()).toMatchObject({ shape: 'square', skin: 'mint', doodads: [] });
    click('蜜桃');
    expect(readAppearance()).toMatchObject({ skin: 'peach', doodads: [] });
    expect(screen.getByTestId('plush-body')).toHaveAttribute('src', '/assets/mascot-dressup/plush/front-square.webp');
    click('小书本'); click('渔夫帽'); click('渔夫帽');
    expect(readAppearance().doodads).toEqual(['book']);
    click('上一步'); click('上一步'); click('帆帆');
    expect(readAppearance()).toMatchObject({ shape: 'drop', skin: 'peach', doodads: ['book'] });
  });
  it('walks colour, shape, colour refinement and accessories before the finished look', () => {
    render(<StepHarness />);
    heading('先选个颜色'); click('薄荷'); heading('选个形状'); click('量量');
    heading('再选个颜色'); expect(screen.queryByRole('button', { name: '量量' })).not.toBeInTheDocument(); click('晴空');
    heading('最后加点配饰'); click('小书本'); click('小披风');
    expect(readAppearance()).toMatchObject({ shape: 'square', skin: 'sky', expression: 'wink' });
    click('完成'); heading('我的 Hermes');
    expect(readAppearance().doodads).toEqual(expect.arrayContaining(['book', 'cape']));
    expect(screen.getByRole('button', { name: '返回自己搭配' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '随机' })).toBeInTheDocument();
  });
  it('goes back through all four steps without losing choices', () => {
    render(<StepHarness />);
    click('蜜桃'); click('轻轻'); click('蜜桃'); heading('最后加点配饰');
    click('上一步'); heading('再选个颜色'); expect(button('蜜桃')).toHaveAttribute('aria-pressed', 'true');
    click('上一步'); heading('选个形状'); expect(button('轻轻')).toHaveAttribute('aria-pressed', 'true');
    click('上一步'); heading('先选个颜色'); expect(button('蜜桃')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: '上一步' })).not.toBeInTheDocument();
    click('蜜桃'); click('轻轻'); click('蜜桃'); click('完成'); click('返回自己搭配');
    heading('先选个颜色'); expect(readAppearance()).toMatchObject({ shape: 'round', skin: 'peach' });
  });
  it('random look jumps straight to the finished look, and shuffle changes silhouette, colour and accessories every time', () => {
    render(<StepHarness />);
    let previous = readAppearance();
    click('随机样式'); heading('我的 Hermes');
    let next = readAppearance();
    expect(next.shape).not.toBe(previous.shape);
    expect(next.skin).not.toBe(previous.skin);
    previous = next;
    for (let round = 0; round < 40; round += 1) {
      click('随机'); heading('我的 Hermes');
      next = readAppearance();
      expect(next.shape).not.toBe(previous.shape);
      expect(next.skin).not.toBe(previous.skin);
      expect([...next.doodads].sort()).not.toEqual([...previous.doodads].sort());
      expect(next.doodads.length).toBeGreaterThan(0);
      expect(next.expression).toBe('wink');
      previous = next;
    }
    click('返回自己搭配'); heading('先选个颜色');
  });
  it('lets the accessory step take a drawing off with a second tap and clear everything', () => {
    const drawn: HermesAppearance = { ...DEFAULT_HERMES_APPEARANCE, drawing: [{ color: '#373044', width: 8, points: [[100, 100], [400, 400]] }] };
    render(<StepHarness initial={drawn} />);
    click('浅紫'); click('游游'); click('浅紫');
    expect(button('自己画')).toHaveAttribute('aria-pressed', 'true');
    click('自己画'); expect(button('自己画')).toHaveAttribute('aria-pressed', 'false');
    expect(readAppearance().drawing).toEqual([]);
    click('全部取下'); expect(readAppearance().doodads).toEqual([]);
  });
  it('mixes all four accessories, removes one and keeps choices when changing shape', () => {
    const save = vi.fn(); render(<Harness onConfirm={save} />);
    for (const name of ['星星眼镜', '小书本', '小披风', '薄荷', '云云']) click(name);
    for (const name of ['星星眼镜', '小披风', '小书本']) expect(button(name)).toHaveAttribute('aria-pressed', 'true');
    click('小披风'); click('就用这个');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ style: 'doodle', shape: 'cloud', skin: 'mint', doodads: ['star-glasses', 'book'] }));
  });
  it('lists round before bean and preserves the six new accessories through save and reload', () => {
    const view = render(<AgentDressupPreview />);
    click('浅紫');
    const shapeButtons = screen.getAllByRole('button').filter((element) => ['轻轻', '游游', '量量', '帆帆', '云云'].includes(element.getAttribute('aria-label') ?? ''));
    expect(shapeButtons.map((element) => element.getAttribute('aria-label'))).toEqual(['轻轻', '游游', '量量', '帆帆', '云云']);
    click('游游'); click('浅紫');
    for (const name of ['星星眼镜', '贝雷帽', '小书本', '小披风']) click(name);
    click('完成'); view.unmount(); render(<AgentDressupPreview />);
    click('浅紫'); click('游游'); click('浅紫');
    for (const name of ['星星眼镜', '贝雷帽', '小书本', '小披风']) expect(button(name)).toHaveAttribute('aria-pressed', 'true');
    click('贝雷帽'); expect(button('贝雷帽')).toHaveAttribute('aria-pressed', 'false');
    expect(button('小披风')).toHaveAttribute('aria-pressed', 'true');
    click('自己画'); expect(screen.getByRole('heading', { name: '自己画' })).toBeInTheDocument();
  });
  it.each(['浅紫', '蜜桃', '奶黄', '薄荷', '晴空'])('keeps %s selection simple without manual expression controls', (name) => {
    render(<Harness />); click(name);
    expect(button(name)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /换个表情/ })).not.toBeInTheDocument();
    expect(screen.queryByText('以后也能改')).not.toBeInTheDocument();
  });
  it('opens drawing as a tool, returns on cancel and preserves current accessories', () => {
    const save = vi.fn(); render(<Harness onConfirm={save} />);
    click('自己画'); expect(screen.getByRole('heading', { name: '自己画' })).toBeInTheDocument();
    click('取消'); click('就用这个');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ doodads: [] }));
  });
  it('takes a drawing off with a second tap and clears it with remove-all', () => {
    const strokes = [{ color: '#373044', width: 8, points: [[100, 100], [400, 400]] as [number, number][] }];
    const save = vi.fn();
    function DrawnHarness() {
      const [value, setValue] = useState<HermesAppearance>({ ...DEFAULT_HERMES_APPEARANCE, drawing: strokes });
      return <AgentDressupStudio value={value} onChange={setValue} onBack={() => {}} onConfirm={save} />;
    }
    render(<DrawnHarness />);
    expect(button('自己画')).toHaveAttribute('aria-pressed', 'true');
    click('自己画');
    expect(screen.queryByRole('heading', { name: '自己画' })).not.toBeInTheDocument();
    expect(button('自己画')).toHaveAttribute('aria-pressed', 'false');
    click('就用这个');
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ drawing: [] }));
  });
  it('remove-all also clears the drawing', () => {
    const save = vi.fn();
    function DrawnHarness() {
      const [value, setValue] = useState<HermesAppearance>({ ...DEFAULT_HERMES_APPEARANCE, drawing: [{ color: '#373044', width: 8, points: [[100, 100], [400, 400]] }] });
      return <AgentDressupStudio value={value} onChange={setValue} onBack={() => {}} onConfirm={save} />;
    }
    render(<DrawnHarness />); click('全部取下'); click('就用这个');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ doodads: [], drawing: [] }));
  });
  it('supports all five shapes and removes accessories without changing shape or color', () => {
    const save = vi.fn(); render(<Harness onConfirm={save} />);
    for (const name of ['游游', '轻轻', '量量', '帆帆', '云云']) { click(name); expect(button(name)).toHaveAttribute('aria-pressed', 'true'); }
    click('奶黄'); click('全部取下'); click('就用这个');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ shape: 'cloud', skin: 'butter', expression: 'open', doodads: [] }));
  });
  it('confirms the displayed new appearance even when editing an older snapshot unchanged', () => {
    const save = vi.fn();
    render(<AgentDressupStudio value={{ version: 1, style: 'soft', skin: 'mint', expression: 'happy', top: 'none', hat: 'none', shoes: 'none', charms: ['star'] }} onChange={() => {}} onBack={() => {}} onConfirm={save} />);
    click('就用这个');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ style: 'doodle', skin: 'mint', expression: 'happy', shape: 'bean', doodads: [] }));
  });
  it('saves shape/color/accessories through create, reload and edit', () => {
    const view = render(<AgentDressupPreview />);
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '小星' } });
    fireEvent.change(screen.getByLabelText(/用途/), { target: { value: '整理灵感' } });
    click('薄荷'); click('量量'); click('晴空'); click('小书本'); click('完成');
    expect(screen.getByLabelText('名字')).toHaveValue('小星');
    view.unmount(); render(<AgentDressupPreview />);
    expect(screen.getByLabelText('名字')).toHaveValue('小星');
    expect(screen.getByLabelText(/用途/)).toHaveValue('整理灵感');
    click('晴空'); expect(button('量量')).toHaveAttribute('aria-pressed', 'true');
    click('量量'); expect(button('晴空')).toHaveAttribute('aria-pressed', 'true');
    click('晴空'); expect(button('小书本')).toHaveAttribute('aria-pressed', 'true');
    click('完成'); click('创建试玩 Agent');
    expect(screen.getByRole('heading', { name: '创建完成' })).toBeInTheDocument();
    click('开始旅程');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('小星')).toBeInTheDocument();
  });
  it('combines ears, hat and eyewear independently while replacing items in the same slot', () => {
    const save = vi.fn(); render(<Harness onConfirm={save} />);
    for (const name of ['奶油耳机', '星星巫师帽', '星星眼镜', '小书本', '小相机', '小披风', '小领巾']) click(name);
    click('就用这个');
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ doodads: expect.arrayContaining(['headphones', 'wizard-hat', 'star-glasses', 'camera', 'scarf']) }));
    expect(save.mock.lastCall?.[0].doodads).not.toContain('book');
    expect(save.mock.lastCall?.[0].doodads).not.toContain('cape');
  });
  it('closes the created preview and makes the console creation entry usable', () => {
    render(<AgentDressupPreview />);
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '小星' } });
    click('创建试玩 Agent');
    expect(screen.queryByRole('button', { name: '修改资料' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续搭配' })).not.toBeInTheDocument();
    click('开始旅程');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    click('创建 Bot');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '创建你的 LightVela Bot' })).toBeInTheDocument();
  });
  it('creates with the default appearance without entering the studio', () => {
    render(<AgentDressupPreview />);
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: 'Hermes' } }); click('创建试玩 Agent');
    expect(screen.getByRole('heading', { name: '创建完成' })).toBeInTheDocument();
  });
});
