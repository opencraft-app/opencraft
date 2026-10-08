import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ update: undefined as undefined | ((s: { progress: number }) => void), kill: vi.fn(), to: vi.fn() }));
vi.mock('gsap', () => ({ gsap: { registerPlugin() {}, set() {}, ticker: { add: vi.fn(), remove: vi.fn() }, timeline() { const t = { to: (...args: unknown[]) => { state.to(...args); return t; }, kill: vi.fn() }; return t; } } }));
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: { create(config: { onUpdate: typeof state.update }) { state.update = config.onUpdate; return { kill: state.kill }; } } }));
import { mountHeroArtwork } from '../home-hero-artwork';
let stop: (() => void) | undefined;
beforeEach(() => {
 vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
 vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(512);
});
const flush = async () => { for(let i=0;i<6;i++) await Promise.resolve(); };

afterEach(() => { stop?.(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
it('uses only the four left friends, supports click and returns after scrolling back', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = '<main><section class="hero"></section></main>';
  document.querySelector('main')!.style.setProperty('--frame-delay', '1670ms');
  stop = mountHeroArtwork(document.querySelector('main')!);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.hero-artwork-friend')];
  expect(buttons).toHaveLength(4);
  expect(document.querySelector<HTMLElement>('.hero-artwork-cast')!.style.animationDelay).toBe('1670ms');
  expect(buttons[0]!.querySelector('img')!.src).toContain('/peek-friends/bean-lilac.webp');
  expect(buttons[1]!.style.width).toBe('148px');
  expect(buttons[1]!.dataset.pose).toBe('grip');
  buttons[1]!.click(); await flush(); expect(buttons[1]!.dataset.waving).toBe('true');
  state.update!({ progress: .35 });
  expect(buttons[1]!.dataset.pose).toBe('reluctant');
  expect(buttons[1]!.querySelectorAll('img:not([hidden])')).toHaveLength(1);
  state.update!({ progress: .5 });
  expect(buttons[0]!.dataset.pose).toBe('arms-up');
  expect(buttons[3]!.dataset.pose).toBe('reluctant');
  state.update!({ progress: .65 });
  expect(buttons[1]!.dataset.pose).toBe('arms-up');
  state.update!({ progress: 1 }); expect(buttons.every(b => b.hidden)).toBe(true);
  state.update!({ progress: 0 }); expect(buttons[1]!.dataset.pose).toBe('grip'); expect(buttons.every(b => !b.hidden)).toBe(true);
  stop(); stop = undefined;
  expect(document.querySelector('.hero-artwork-cast')).toBeNull();
  expect(state.kill).toHaveBeenCalledOnce();
});

it('waves only the hovered character, stops on leave, and supports repeated entry', async()=>{
 vi.useFakeTimers();vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 document.body.innerHTML='<main><section class="hero"></section></main>';
 stop=mountHeroArtwork(document.querySelector('main')!);
 const buttons=[...document.querySelectorAll<HTMLButtonElement>('.hero-artwork-friend')];
 for(const button of buttons){
  button.dispatchEvent(new Event('pointerenter'));await flush();
  expect(button.dataset.waving).toBe('true');
  expect(buttons.filter(b=>b.dataset.waving==='true')).toHaveLength(1);
  vi.advanceTimersByTime(220);
  expect(button.querySelectorAll<HTMLImageElement>('.hero-artwork-wave')[0]!.hidden).toBe(true);
  expect(button.querySelectorAll<HTMLImageElement>('.hero-artwork-wave')[1]!.hidden).toBe(false);
  button.dispatchEvent(new Event('pointerleave'));
  expect(button.dataset.waving).toBe('false');
  expect(button.querySelectorAll('img:not([hidden])')).toHaveLength(1);
 }
 buttons[0]!.dispatchEvent(new Event('pointerenter'));await flush();
 expect(buttons[0]!.dataset.waving).toBe('true');
 state.update!({progress:.7});expect(buttons[0]!.dataset.waving).toBe('false');
 stop();stop=undefined;expect(vi.getTimerCount()).toBe(0);
});
it('honors reduced motion and does not reveal missing greeting assets',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
 document.body.innerHTML='<main><section class="hero"></section></main>';
 stop=mountHeroArtwork(document.querySelector('main')!);
 const button=document.querySelector<HTMLButtonElement>('.hero-artwork-friend')!;
 button.dispatchEvent(new Event('focus'));await flush();expect(button.dataset.waving).not.toBe('true');
 expect(button.querySelectorAll('img:not([hidden])')).toHaveLength(1);
 stop();stop=undefined;
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
 vi.spyOn(HTMLImageElement.prototype,'naturalWidth','get').mockReturnValue(0);
 stop=mountHeroArtwork(document.querySelector('main')!);
 const unloaded=document.querySelector<HTMLButtonElement>('.hero-artwork-friend')!;
 unloaded.dispatchEvent(new Event('pointerenter'));await flush();
 expect(unloaded.dataset.waving).not.toBe('true');expect(unloaded.querySelectorAll('img:not([hidden])')).toHaveLength(1);
});

it('keeps friends perched and cropped at the frame edge under reduced motion while scrolling', () => {
 vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
 document.body.innerHTML = '<main><section class="hero"><div class="hero__frame"><div class="im"></div></div></section></main>';
 const top = window.innerHeight - 200;
 vi.spyOn(document.querySelector<HTMLElement>('.im')!, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 400, left: 100, right: 500, width: 400, height: 400, x: 100, y: top, toJSON() {} }));
 stop = mountHeroArtwork(document.querySelector('main')!);
 const buttons = [...document.querySelectorAll<HTMLButtonElement>('.hero-artwork-friend')];
 const cast = document.querySelector<HTMLElement>('.hero-artwork-cast')!;
 for (const progress of [.5, 1]) {
  state.update!({ progress });
  // Nobody lets go, so nobody disappears and the bodies stay hidden below the edge.
  expect(buttons.every(b => !b.hidden && b.dataset.pose === 'grip')).toBe(true);
  // The layer ends exactly on the window border, so nothing is drawn below it.
  expect(cast.style.height).toBe(`${top}px`);
 }
});

it('waits for the inner chat border when returning from below', () => {
 vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
 document.body.innerHTML = '<main><section class="hero"><div class="hero__frame"><div class="im"></div></div></section></main>';
 const inner = document.querySelector<HTMLElement>('.im')!;
 let top = window.innerHeight + 40;
 vi.spyOn(inner, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 400, left: 100, right: 500, width: 400, height: 400, x: 100, y: top, toJSON() {} }));
 stop = mountHeroArtwork(document.querySelector('main')!);
 const cast = document.querySelector<HTMLElement>('.hero-artwork-cast')!;
 expect(cast.style.visibility).toBe('hidden');
 top = window.innerHeight - 100;
 state.update!({ progress: 0 });
 expect(cast.style.visibility).toBe('visible');
 expect(cast.style.height).toBe(`${top}px`);
});

it('anchors the friends in document coordinates so native scrolling carries them', () => {
 vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
 document.body.innerHTML = '<main><section class="hero"><div class="hero__frame"><div class="im"></div></div></section></main>';
 let top = 500;
 vi.spyOn(document.querySelector<HTMLElement>('.im')!, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 400, left: 100, right: 500, width: 400, height: 400, x: 100, y: top, toJSON() {} }));
 vi.stubGlobal('scrollY', 0);
 stop = mountHeroArtwork(document.querySelector('main')!);
 const cast = document.querySelector<HTMLElement>('.hero-artwork-cast')!;
 const button = document.querySelector<HTMLButtonElement>('.hero-artwork-friend')!;
 const before = [cast.style.height, button.style.top, button.style.left];
 // The page scrolls 120px: the border moves up in the viewport, the document does not change.
 vi.stubGlobal('scrollY', 120); top = 380;
 state.update!({ progress: .1 });
 expect([cast.style.height, button.style.top, button.style.left]).toEqual(before);
});
