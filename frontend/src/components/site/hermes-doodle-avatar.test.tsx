import { act, cleanup, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ImgHTMLAttributes } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesDoodleAvatar } from './hermes-doodle-avatar';
import { DEFAULT_HERMES_APPEARANCE } from '@/lib/hermes-appearance';

vi.mock('framer-motion', () => ({
  useReducedMotion: () => false,
  motion: {
    div: ({ children, animate: _animate, initial: _initial, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & { animate?: unknown; initial?: unknown; transition?: unknown }) => <div {...props}>{children}</div>,
    img: ({ animate: _animate, transition: _transition, ...props }: ImgHTMLAttributes<HTMLImageElement> & { animate?: unknown; transition?: unknown }) => <img {...props} />,
  },
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Hermes automatic expressions', () => {
  it('cycles expressions only while alive and in view, pauses for drawing, and cleans timers', () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() {}
    });
    const view = render(<HermesDoodleAvatar appearance={DEFAULT_HERMES_APPEARANCE} alive />);
    const avatar = screen.getByTestId('dressup-preview');
    expect(avatar).toHaveAttribute('data-expression', 'open');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(avatar).toHaveAttribute('data-expression', 'wink');
    act(() => { vi.advanceTimersByTime(1200); });
    expect(avatar).toHaveAttribute('data-expression', 'open');
    act(() => { vi.advanceTimersByTime(3400); });
    expect(avatar).toHaveAttribute('data-expression', 'happy');
    view.rerender(<HermesDoodleAvatar appearance={DEFAULT_HERMES_APPEARANCE} alive={false} />);
    act(() => { vi.advanceTimersByTime(9000); });
    expect(avatar).toHaveAttribute('data-expression', 'open');
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
