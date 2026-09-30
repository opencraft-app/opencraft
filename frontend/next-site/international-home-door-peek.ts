import { gsap } from 'gsap';

let nextClipId = 0;
const ASSET_ROOT = '/lightvela-intl-home/assets/';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountDoorPeek(portal: HTMLElement): () => void {
  const artwork = portal.querySelector('svg');
  if (!artwork || artwork.getAttribute('viewBox') !== '0 0 964 966') return () => {};
  let disposed = false;
  let timeline: gsap.core.Timeline | undefined;
  let layers: SVGGElement | undefined;
  let definitions: SVGDefsElement | undefined;
  let pausedForVisibility = false;
  let guidedProgress: number | undefined;
  const guide = (event: Event) => {
    const progress = (event as CustomEvent<{ progress: number }>).detail?.progress;
    if (disposed || typeof progress !== 'number' || !Number.isFinite(progress)) return;
    guidedProgress = Math.max(0, Math.min(1, progress));
    if (!timeline || !layers) return;
    timeline.scrollTrigger?.kill(false);
    timeline.pause().progress(guidedProgress, true);
    layers.style.display = guidedProgress >= 1 ? 'none' : '';
    portal.dataset.doorPeek = guidedProgress >= 1 ? 'complete' : guidedProgress > 0 ? 'playing' : 'ready';
  };
  portal.addEventListener('lightvela-companion-door', guide);
  const loads: Array<() => void> = [];
  const originalState = portal.getAttribute('data-door-peek');

  function preload(file: string) {
    return new Promise<boolean>((resolve) => {
      const image = new Image();
      const finish = (ok: boolean) => {
        image.onload = null;
        image.onerror = null;
        resolve(ok);
      };
      loads.push(() => finish(false));
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = `${ASSET_ROOT}${file}`;
    });
  }

  function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  void Promise.all([preload('hermes-door-background.webp'), preload('hermes-door-character.webp')]).then((ready) => {
    if (disposed || !portal.isConnected || ready.some((ok) => !ok)) return;
    const clipId = `home-door-peek-${++nextClipId}`;
    definitions = svg('defs', {});
    const clip = svg('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svg('polygon', { points: '374,151 529,44 529,774 374,760' }));
    definitions.appendChild(clip);
    layers = svg('g', { class: 'home-door-peek-layers', 'aria-hidden': 'true', 'pointer-events': 'none' });
    const background = svg('image', {
      class: 'home-door-peek-background', href: `${ASSET_ROOT}hermes-door-background.webp`,
      width: '964', height: '966', preserveAspectRatio: 'xMidYMid meet',
    });
    const doorway = svg('g', { 'clip-path': `url(#${clipId})` });
    const character = svg('g', { class: 'home-door-peek-character' });
    character.appendChild(svg('image', {
      href: `${ASSET_ROOT}hermes-door-character.webp`, x: '374', y: '430', width: '128', height: '244',
    }));
    doorway.appendChild(character);
    layers.append(background, doorway);
    artwork.append(definitions, layers);
    portal.dataset.doorPeek = 'ready';
    timeline = gsap.timeline({
      scrollTrigger: { trigger: portal, start: 'top 82%', toggleActions: 'play pause resume pause' },
      onStart: () => { portal.dataset.doorPeek = 'playing'; },
      onComplete: () => {
        if (layers) layers.style.display = 'none';
        portal.dataset.doorPeek = 'complete';
      },
    });
    timeline.fromTo(character, { x: -136, y: 7, rotation: -5, svgOrigin: '374 620' }, {
      x: -40, y: 2, rotation: -2, duration: 0.7, ease: 'power2.out',
    }, 0.18)
      .to(character, { x: 0, y: 0, rotation: 0, duration: 0.6, ease: 'power2.inOut' }, '+=0.18')
      .to(character, { x: -12, y: 2, rotation: -1.5, duration: 0.32, ease: 'sine.inOut' }, '+=0.65')
      .to(character, { x: 0, y: 0, rotation: 0, duration: 0.4, ease: 'sine.out' });
    timeline.scrollTrigger?.refresh();
    if (guidedProgress !== undefined) guide(new CustomEvent('lightvela-companion-door', { detail: { progress: guidedProgress } }));
    portal.dispatchEvent(new Event('lightvela-door-ready', { bubbles: true }));
    if (document.hidden) { timeline.pause(); pausedForVisibility = true; }
  });

  const visibility = () => {
    if (!timeline) return;
    if (document.hidden && timeline.isActive()) {
      pausedForVisibility = true;
      timeline.pause();
    } else if (!document.hidden && pausedForVisibility) {
      pausedForVisibility = false;
      if (timeline.scrollTrigger?.isActive) timeline.resume();
    }
  };
  document.addEventListener('visibilitychange', visibility);
  return () => {
    disposed = true;
    loads.forEach((cancel) => cancel());
    timeline?.scrollTrigger?.kill();
    timeline?.kill();
    layers?.remove();
    definitions?.remove();
    document.removeEventListener('visibilitychange', visibility);
    portal.removeEventListener('lightvela-companion-door', guide);
    if (originalState === null) portal.removeAttribute('data-door-peek');
    else portal.setAttribute('data-door-peek', originalState);
  };
}
