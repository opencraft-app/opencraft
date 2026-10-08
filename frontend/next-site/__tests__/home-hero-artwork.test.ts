import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ update: undefined as undefined | ((s: { progress: number }) => void), end: undefined as undefined | (() => number), kill: vi.fn(), to: vi.fn(), set: vi.fn() }));
vi.mock('gsap', () => ({ gsap: { registerPlugin() {}, set: state.set, ticker: { add: vi.fn(), remove: vi.fn() }, timeline() { const t = { to: (...args: unknown[]) => { state.to(...args); return t; }, kill: vi.fn() }; return t; } } }));
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: { create(config: { onUpdate: typeof state.update; end: () => number }) { state.update = config.onUpdate; state.end = config.end; return { kill: state.kill }; } } }));
import { mountHeroArtwork } from '../home-hero-artwork';
let stop: (() => void) | undefined;
beforeEach(() => {
 vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
 vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(512);
});
// Drain the microtask queue this test relies on (image decode()/complete callbacks
// chain a few levels of resolved promises); six passes has been enough to settle them.
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function mountFeatureScene(reduced = false) {
 vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
 vi.stubGlobal('innerWidth', 1440);
 vi.stubGlobal('innerHeight', 900);
 vi.stubGlobal('scrollY', 0);
 document.body.innerHTML = '<main><nav class="nav"></nav><section class="hero"><div class="hero__frame"><div class="im"></div></div></section><section class="about"><header class="about__head"></header></section></main>';
 const root = document.querySelector('main')!;
 const hero = root.querySelector<HTMLElement>('.hero')!;
 const frame = root.querySelector<HTMLElement>('.im')!;
 let headingTop = 1280;
 let navHeight = 65;
 const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 230, right: 1210, width: 980, height, x: 230, y: top, toJSON() {} });
 vi.spyOn(hero, 'offsetHeight', 'get').mockReturnValue(1184);
 vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => rect(493 - window.scrollY, 652));
 const heading = root.querySelector<HTMLElement>('.about__head')!;
 const section = root.querySelector<HTMLElement>('.about')!;
 vi.spyOn(heading, 'offsetTop', 'get').mockReturnValue(80);
 vi.spyOn(heading, 'offsetParent', 'get').mockReturnValue(section);
 vi.spyOn(section, 'offsetTop', 'get').mockImplementation(() => headingTop - 80);
 vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() => rect(headingTop - window.scrollY + 16, 42));
 vi.spyOn(root.querySelector<HTMLElement>('.nav')!, 'offsetHeight', 'get').mockImplementation(() => navHeight);
 stop = mountHeroArtwork(root);
 const buttons = [...document.querySelectorAll<HTMLButtonElement>('.hero-artwork-friend')];
 return {
  buttons,
  cast: document.querySelector<HTMLElement>('.hero-artwork-cast')!,
  layout: (top: number, height: number) => { headingTop = top; navHeight = height; },
  scroll: (y: number) => { vi.stubGlobal('scrollY', y); state.update!({ progress: Math.min(1, y / state.end!()) }); },
  screenTop: (button: HTMLButtonElement) => {
   const args = state.set.mock.calls.filter(([target, values]) => target === button && 'x' in values).at(-1)!;
   return parseFloat(button.style.top) + (args[1] as { y: number }).y - window.scrollY;
  },
 };
}

it('finishes at the core-features heading below the navigation and remeasures its position', () => {
 const scene = mountFeatureScene();
 expect(state.end!()).toBe(1183);
 scene.scroll(600);
 expect(state.end!()).toBe(1183);
 scene.layout(1500, 80);
 expect(state.end!()).toBe(1388);
});

it('keeps falling through the old endpoint without leaving the viewport early', () => {
 const scene = mountFeatureScene();
 let previous = -Infinity;
 for (const y of [400, 600, 900, 1120]) {
  scene.scroll(y);
  expect(scene.buttons.every(b => !b.hidden)).toBe(true);
  const top = scene.screenTop(scene.buttons[3]!);
  expect(top).toBeGreaterThan(previous);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(window.innerHeight - 32);
  previous = top;
 }
});

it('does not disappear with the chat window, exits at the features screen and reverses on return', () => {
 const scene = mountFeatureScene();
 scene.scroll(1160);
 expect(document.querySelector('.im')!.getBoundingClientRect().bottom).toBeLessThan(0);
 expect(scene.cast.style.visibility).toBe('visible');
 expect(scene.cast.style.opacity).toBe('1');
 expect(scene.buttons.every(b => !b.hidden)).toBe(true);
 scene.scroll(state.end!());
 expect(scene.buttons.every(b => b.hidden)).toBe(true);
 scene.scroll(900);
 expect(scene.buttons.every(b => !b.hidden)).toBe(true);
 expect(scene.cast.style.visibility).toBe('visible');
 scene.scroll(0);
 expect(scene.buttons.every(b => b.dataset.pose === 'grip')).toBe(true);
});

it('does not detach the reduced-motion friends when the chat window scrolls away', () => {
 const scene = mountFeatureScene(true);
 scene.scroll(1160);
 expect(scene.cast.style.visibility).toBe('hidden');
 expect(scene.buttons.every(b => b.dataset.pose === 'grip')).toBe(true);
});

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
