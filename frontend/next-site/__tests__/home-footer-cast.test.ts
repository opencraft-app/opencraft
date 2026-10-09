import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountFooterCast } from '../home-footer-cast';

const state = vi.hoisted(() => ({ enter: (_visible: boolean) => {}, reduced: false }));
let dispose: (() => void) | undefined;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.reduced = false;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) {
      state.enter = visible => callback([{ isIntersecting: visible, intersectionRatio: visible ? .5 : 0 }]);
    }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('matchMedia', () => ({ get matches() { return state.reduced; }, addEventListener() {}, removeEventListener() {} }));
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  document.body.innerHTML = '<main><nav class="nav"></nav><footer class="foot"><div class="foot__links">Links</div><a href="/pricing">Pricing</a></footer></main>';
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('mounts the approved video once, keeps footer links, and cleans up', () => {
  const root = document.querySelector<HTMLElement>('main')!;
  dispose = mountFooterCast(root);
  const duplicate = mountFooterCast(root);
  const video = root.querySelector<HTMLVideoElement>('.home-footer-cast__video')!;
  expect(video.src).toContain('/footer-cast-video.mp4');
  expect(video.poster).toContain('/footer-cast-first.webp');
  expect(video.muted).toBe(true);
  expect(video.playsInline).toBe(true);
  expect(root.querySelectorAll('video')).toHaveLength(2);
  expect(root.querySelector<HTMLVideoElement>('.home-footer-cast__loop')?.src).toContain('/footer-cast-pingpong.mp4');
  expect(root.querySelectorAll('.home-footer-cast__still')).toHaveLength(1);
  expect(root.querySelector('.home-footer-cast__star,.home-footer-cast__original')).toBeNull();
  duplicate();
  expect(root.querySelectorAll('video')).toHaveLength(2);
  dispose();
  expect(root.querySelector('video')).toBeNull();
  expect(root.querySelector('a')?.textContent).toBe('Pricing');
  expect(root.querySelector('footer')?.classList.contains('has-footer-portrait')).toBe(false);
});

it('plays the arrival once, switches to a seamless ping-pong loop, and restarts after leaving', () => {
  dispose = mountFooterCast(document.querySelector<HTMLElement>('main')!);
  const video = document.querySelector<HTMLVideoElement>('.home-footer-cast__video')!;
  const loop = document.querySelector<HTMLVideoElement>('.home-footer-cast__loop')!;
  vi.spyOn(video, 'readyState', 'get').mockReturnValue(HTMLMediaElement.HAVE_METADATA);
  vi.spyOn(loop, 'readyState', 'get').mockReturnValue(HTMLMediaElement.HAVE_METADATA);
  state.enter(true);
  expect(play).toHaveBeenCalledTimes(1);
  video.dispatchEvent(new Event('ended'));
  expect(loop.loop).toBe(true);
  expect(play).toHaveBeenCalledTimes(2);
  expect(play.mock.instances[1]).toBe(loop);
  loop.dispatchEvent(new Event('playing'));
  expect(loop.parentElement?.classList.contains('is-looping')).toBe(true);
  state.enter(false);
  expect(pause).toHaveBeenCalled();
  expect(video.currentTime).toBe(0);
  expect(loop.currentTime).toBe(0);
  expect(loop.parentElement?.classList.contains('is-looping')).toBe(false);
  state.enter(true);
  expect(play).toHaveBeenCalledTimes(3);
  expect(play.mock.instances[2]).toBe(video);
  expect(video.currentTime).toBe(0);
});

it('uses the final still and does not autoplay for reduced motion', () => {
  state.reduced = true;
  dispose = mountFooterCast(document.querySelector<HTMLElement>('main')!);
  state.enter(true);
  expect(play).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLImageElement>('.home-footer-cast__still')?.src).toContain('/footer-cast-final.webp');
});
