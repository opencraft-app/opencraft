import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HERMES_APPEARANCE, HERMES_DRAWING_LIMITS, type HermesAppearance, type HermesDrawingStroke } from '@/lib/hermes-appearance';
import { HermesDrawingEditor } from '@/components/site/hermes-drawing-editor';
import { HermesDrawingLayer } from '@/components/site/hermes-drawing-layer';
vi.mock('@/components/site/hermes-doodle-avatar', () => ({ HermesDoodleAvatar: ({ appearance }: { appearance: HermesAppearance }) => <span data-testid="drawing-avatar" data-drawing={JSON.stringify(appearance.drawing)} /> }));
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number; readonly isPrimary: boolean;
  constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; this.isPrimary = options.isPrimary ?? true; }
}
beforeEach(() => vi.stubGlobal('PointerEvent', TestPointerEvent));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const button = (name: string) => screen.getByRole('button', { name });
function setup(drawing: HermesDrawingStroke[] = []) {
  const onConfirm = vi.fn(), onCancel = vi.fn(), appearance = { ...DEFAULT_HERMES_APPEARANCE, drawing };
  render(<HermesDrawingEditor appearance={appearance} zh onConfirm={onConfirm} onCancel={onCancel} />);
  const canvas = screen.getByTestId('hermes-drawing-canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 300, 300));
  const setCapture = vi.fn(), releaseCapture = vi.fn();
  Object.assign(canvas, { setPointerCapture: setCapture, hasPointerCapture: () => true, releasePointerCapture: releaseCapture });
  const dot = () => { fireEvent.pointerDown(canvas, { clientX: 160, clientY: 170, pointerId: 1, button: 0 }); fireEvent.pointerUp(canvas, { clientX: 160, clientY: 170, pointerId: 1 }); };
  return { canvas, onConfirm, onCancel, appearance, dot, setCapture, releaseCapture };
}
describe('Hermes drawing editor', () => {
  it('captures normalized drag and confirms once without mutating the avatar', () => {
    const { canvas, onConfirm, appearance, setCapture, releaseCapture } = setup();
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 50, pointerId: 7, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 170, pointerId: 7 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 170, pointerId: 7 });
    fireEvent.click(button('完成涂鸦')); fireEvent.click(button('完成涂鸦'));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith([{ color: '#373044', width: 8, points: [[100, 100], [500, 500]] }]);
    expect(appearance.drawing).toEqual([]); expect(screen.getByTestId('drawing-avatar')).toHaveAttribute('data-drawing', '[]');
    expect(setCapture).toHaveBeenCalledWith(7); expect(releaseCapture).toHaveBeenCalledWith(7);
  });
  it('supports dots, undo, reversible clear and cancel without saving', () => {
    const { dot, onConfirm, onCancel, appearance } = setup();
    fireEvent.click(button('珊瑚')); fireEvent.click(button('粗笔')); dot();
    expect(screen.getByTestId('hermes-drawing-layer').querySelector('circle')).toHaveAttribute('r', '9');
    fireEvent.click(button('清空')); expect(screen.getByTestId('hermes-drawing-layer').children).toHaveLength(0);
    fireEvent.click(button('撤销')); expect(screen.getByTestId('hermes-drawing-layer').querySelector('circle')).toHaveAttribute('fill', '#F47B84');
    fireEvent.click(button('撤销')); expect(screen.getByTestId('hermes-drawing-layer').children).toHaveLength(0);
    dot(); fireEvent.click(button('取消')); expect(onCancel).toHaveBeenCalledOnce(); expect(onConfirm).not.toHaveBeenCalled(); expect(appearance.drawing).toEqual([]);
  });
  it('clamps coordinates, ignores non-primary input and releases on pointercancel', () => {
    const { canvas, onConfirm, dot } = setup();
    fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0, pointerId: 2, isPrimary: false });
    fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0, pointerId: 3, button: 2 });
    fireEvent.pointerDown(canvas, { clientX: -20, clientY: 35, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 200, pointerId: 9 });
    fireEvent.pointerMove(canvas, { clientX: 500, clientY: -5, pointerId: 1 }); fireEvent.pointerCancel(canvas, { pointerId: 1 });
    dot(); fireEvent.click(button('完成涂鸦'));
    expect(onConfirm.mock.calls[0]![0]).toEqual([{ color: '#373044', width: 8, points: [[0, 50], [1000, 0]] }, { color: '#373044', width: 8, points: [[500, 500]] }]);
  });
  it('caps each stroke with visible feedback without discarding captured points', () => {
    const { canvas, onConfirm } = setup();
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 20, pointerId: 1, button: 0 });
    for (let i = 1; i <= 310; i++) fireEvent.pointerMove(canvas, { clientX: 10 + i % 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 100, pointerId: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('这一笔画满了'); fireEvent.click(button('完成涂鸦'));
    expect(onConfirm.mock.calls[0]![0][0].points).toHaveLength(HERMES_DRAWING_LIMITS.maxPointsPerStroke);
  });
  it('blocks full drawings and allows saved strokes to be undone', () => {
    const drawing = Array.from({ length: 8 }, (): HermesDrawingStroke => ({ color: '#373044', width: 8, points: Array.from({ length: 300 }, (_, i) => [i, i]) }));
    const { dot, onConfirm } = setup(drawing); dot(); expect(screen.getByRole('status')).toHaveTextContent('画纸快满了');
    fireEvent.click(button('撤销')); dot(); fireEvent.click(button('完成涂鸦'));
    expect(onConfirm.mock.calls[0]![0]).toHaveLength(8); expect(onConfirm.mock.calls[0]![0].at(-1).points).toEqual([[500, 500]]); expect(drawing).toHaveLength(8);
  });
  it('blocks strokes above the stroke budget', () => {
    const drawing = Array.from({ length: 60 }, (): HermesDrawingStroke => ({ color: '#373044', width: 8, points: [[20, 20]] }));
    const { dot, onConfirm } = setup(drawing); dot(); fireEvent.click(button('完成涂鸦'));
    expect(onConfirm.mock.calls[0]![0]).toHaveLength(60); expect(screen.getByRole('status')).toHaveTextContent('画纸快满了');
  });
  it('renders saved paths and dots in an inert shared SVG', () => {
    render(<HermesDrawingLayer strokes={[{ color: '#FF0000', width: 18, points: [[10, 20], [30, 40]] }, { color: '#FFFFFF', width: 8, points: [[5, 6]] }]} />);
    const layer = screen.getByTestId('hermes-drawing-layer'); expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer.querySelector('path')).toHaveAttribute('d', 'M10,20 L30,40'); expect(layer.querySelector('circle')).toHaveAttribute('r', '4');
  });
});
