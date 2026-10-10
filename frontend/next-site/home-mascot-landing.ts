const VIDEO = '/lightvela-intl-home/assets/mascot-four-landing-v6-refined.webm';
const STILL = '/lightvela-intl-home/assets/mascot-four-landing-v6-refined-still.webp';
const LANDING_STATE = { STILL: 'still', WAITING: 'waiting', BUFFERING: 'buffering', PLAYING: 'playing' } as const;
export type MascotLanding = { element: HTMLElement; land: () => void; reset: () => void; ready: () => boolean; active: () => boolean; stop: () => void };

/** Finite playback of the approved tumble-and-rescue clip; pauses outside the viewport. */
export function mountMascotLanding(root: HTMLElement): MascotLanding | undefined {
  const scenes = root.querySelector<HTMLElement>('.scenes');
  if (!scenes || root.querySelector('.home-mascot-landing')) return;
  const element = document.createElement('div');
  element.className = 'home-mascot-landing'; element.setAttribute('aria-hidden', 'true');
  const media = document.createElement('div');
  media.className = 'home-mascot-landing__media';
  const video = document.createElement('video');
  video.src = VIDEO; video.preload = 'none'; video.muted = true;
  video.defaultMuted = true; video.playsInline = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
  const still = document.createElement('img');
  still.src = STILL; still.alt = ''; still.width = 1280; still.height = 720;
  still.decoding = 'async';
  media.append(video, still);
  element.append(media); scenes.before(element);
  // Use layout coordinates: the heading entrance temporarily translates its
  // visual rectangle, which must not move the permanent landing floor.
  function layoutTop(node: HTMLElement) {
    let top = 0;
    for (let current: HTMLElement | null = node; current; current = current.offsetParent as HTMLElement | null) top += current.offsetTop;
    return top;
  }
  function alignWithTitle() {
    const title = scenes!.querySelector<HTMLElement>('.scenes__title');
    if (!title) return;
    const titleRect = title.getBoundingClientRect();
    const stageRect = element.getBoundingClientRect();
    const width = media.getBoundingClientRect().width;
    // Reserve the full frame floor, including the lowest feet during playback.
    media.style.left = `${titleRect.left - width * .21 - stageRect.left}px`;
    media.style.top = `${layoutTop(title) - layoutTop(element) - width * 9 / 16 - 8}px`;
  }
  alignWithTitle();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let landed = false, visible = false, prepared = false, disposed = false, complete = false;
  const staticMode = () => reduced.matches || window.innerWidth < 900 || typeof IntersectionObserver !== 'function';
  const showStill = () => { element.dataset.state = LANDING_STATE.STILL; };
  function syncPlayback() {
    if (disposed) return;
    element.dataset.paused = String(!visible || document.hidden);
    if (staticMode()) { video.pause(); showStill(); return; }
    if (!landed || !visible || document.hidden || complete) { video.pause(); return; }
    if (video.paused) void video.play().catch(showStill);
  }
  function reset(force = false) {
    if (!force && !landed && element.dataset.state === LANDING_STATE.WAITING) return;
    landed = false; complete = false; greeting?.cancel(); video.pause();
    if (video.readyState >= 1) video.currentTime = 0;
    alignWithTitle();
    element.dataset.state = staticMode() ? LANDING_STATE.STILL : LANDING_STATE.WAITING;
  }
  function land() {
    if (disposed || landed || staticMode()) return;
    landed = true;
    alignWithTitle();
    element.dataset.state = LANDING_STATE.BUFFERING;
    syncPlayback();
  }
  const decoded = () => { alignWithTitle(); root.dispatchEvent(new Event('mascotlandingready')); };
  video.addEventListener('loadeddata', decoded);
  const playing = () => { alignWithTitle(); if (!disposed && landed) element.dataset.state = LANDING_STATE.PLAYING; };
  const ended = () => { complete = true; showStill(); };
  // A finite hover greeting; the current flattened clip has no separate hand rig.
  let greeting: Animation | undefined;
  let lastGreeting = -Infinity;
  const greet = (event: PointerEvent) => {
    if (disposed || reduced.matches || event.pointerType === 'touch' || document.hidden ||
        element.dataset.state !== LANDING_STATE.STILL || performance.now() - lastGreeting < 1600) return;
    if (typeof still.animate !== 'function') return;
    lastGreeting = performance.now();
    greeting?.cancel();
    greeting = still.animate([
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: 'translateY(-3px) rotate(-.6deg)', offset: .3 },
      { transform: 'translateY(-1px) rotate(.4deg)', offset: .65 },
      { transform: 'translateY(0) rotate(0deg)' },
    ], { duration: 700, easing: 'ease-in-out' });
  };
  still.addEventListener('pointerenter', greet);

  video.addEventListener('playing', playing);
  video.addEventListener('ended', ended);
  video.addEventListener('error', showStill);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    const approaching = entries.some(entry => entry.isIntersecting);
    const rect = element.getBoundingClientRect();
    visible = approaching && rect.bottom > 0 && rect.top < window.innerHeight;
    if (approaching && !prepared && !staticMode()) {
      prepared = true; video.preload = 'auto'; video.load();
    }
    syncPlayback();
  }, { rootMargin: '600px 0px', threshold: 0 }) : undefined;
  observer?.observe(element);
  let visibilityFrame = 0;
  const updateVisibility = () => {
    if (visibilityFrame || disposed) return;
    visibilityFrame = requestAnimationFrame(() => {
      visibilityFrame = 0;
      if (disposed) return;
      const rect = element.getBoundingClientRect();
      visible = rect.bottom > 0 && rect.top < window.innerHeight;
      syncPlayback();
    });
  };
  window.addEventListener('scroll', updateVisibility, { passive: true });
  const resize = () => { reset(true); };
  const preference = () => { reset(true); };
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('resize', resize);
  reduced.addEventListener('change', preference);
  const title = scenes.querySelector<HTMLElement>('.scenes__title');
  const layoutObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(alignWithTitle) : undefined;
  if (title) layoutObserver?.observe(title);
  layoutObserver?.observe(scenes);
  void document.fonts?.ready.then(() => { if (!disposed) alignWithTitle(); });
  reset();
  return { element, land, reset, ready: () => video.readyState >= 2, active: () => landed, stop: () => {
    disposed = true; greeting?.cancel(); still.removeEventListener('pointerenter', greet); cancelAnimationFrame(visibilityFrame); video.pause(); observer?.disconnect(); layoutObserver?.disconnect();
    video.removeEventListener('loadeddata', decoded);
    video.removeEventListener('playing', playing); video.removeEventListener('ended', ended);
    video.removeEventListener('error', showStill);
    video.removeAttribute('src'); element.remove();
    document.removeEventListener('visibilitychange', syncPlayback);
    window.removeEventListener('scroll', updateVisibility);
    window.removeEventListener('resize', resize); reduced.removeEventListener('change', preference);
  } };
}
