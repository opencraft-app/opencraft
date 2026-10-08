import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { CAST, heroPose, clamp, smooth } from './home-scroll-cast-state';

// Reuse the four approved peeking characters from the testimonial artwork.
// Sizes compensate for each artwork's transparent margin, so the visible
// bodies read as one evenly sized group (about 82 / 104 / 80 / 96px wide).
const ART = [
  ['bean-lilac', 175], ['round-coral', 185], ['square-mint', 185],
  ['drop-sky', 198],
] as const;
// Desktop layout taken from the reference: box left offset in px, and the
// artwork row (of 512) that sits on the window's top edge, just below each mouth.
const LAYOUT = [
  { left: -29, crop: 345 }, { left: 48, crop: 350 },
  { left: 113, crop: 415 }, { left: 170, crop: 365 },
] as const;
// The lilac friend lets go first; the blue one stays on the edge longest.
const HERO_DELAYS = [0, .08, .15, .25] as const;
export const HERO_ARTWORK_TRIGGER_ID = 'hero-artwork-position';
// The homepage is served in several locales, so the decorative friend buttons
// must not hardcode a Chinese accessible name. Mirror the per-locale copy table
// used by hero-chat.js and fall back to English for any unlisted locale.
function heroFriendLabel(locale: string, index: number): string {
  const n = index + 1;
  const lower = (locale || '').toLowerCase();
  if (lower.startsWith('zh-hant')) return `和第 ${n} 位 Hermes 揮手打招呼`;
  if (lower.startsWith('zh')) return `和第 ${n} 位 Hermes 挥手打招呼`;
  if (lower.startsWith('id')) return `Lambaikan tangan ke teman Hermes ke-${n}`;
  if (lower.startsWith('es')) return `Saluda al amigo Hermes ${n}`;
  if (lower.startsWith('ja')) return `${n}体目のHermesに手を振って挨拶する`;
  if (lower.startsWith('ko')) return `${n}번째 Hermes에게 손 흔들어 인사하기`;
  return `Wave hello to Hermes friend ${n}`;
}
export function mountHeroArtwork(root: HTMLElement): () => void {
  const locale = root.dataset.locale || document.documentElement.lang || 'en-US';
  const hero = root.querySelector<HTMLElement>('.hero');
  if (!hero) return () => {};
  const heroElement: HTMLElement = hero;
  const frame = hero.querySelector<HTMLElement>('.hero__frame');
  const featuresHeading = root.querySelector<HTMLElement>('.about__head');
  const navigation = root.querySelector<HTMLElement>('.nav');
  const gripEnd = () => Math.max(280, Math.min(window.innerHeight * .90, heroElement.offsetHeight - window.innerHeight * .65));
  const exitEnd = () => {
    if (!featuresHeading) return gripEnd();
    let top = 0;
    for (let element: HTMLElement | null = featuresHeading; element; element = element.offsetParent as HTMLElement | null) {
      top += element.offsetTop;
    }
    return Math.max(gripEnd(), top - (navigation?.offsetHeight ?? 64) - 32);
  };
  gsap.registerPlugin(ScrollTrigger);
  const layer = document.createElement('div');
  layer.className = 'hero-artwork-cast';
  // The frame inherits its delay from the homepage root. The detached cast
  // would otherwise inherit the document's longer headline sequence delay.
  const frameDelay = getComputedStyle(root).getPropertyValue('--frame-delay').trim();
  if (frameDelay) layer.style.animationDelay = frameDelay;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let progress = 0;
  let disposed = false;
  const actors = ART.map(([name, size], i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hero-artwork-friend';
    button.setAttribute('aria-label', heroFriendLabel(locale, i));
    button.style.setProperty('--friend-size', `${size}px`);
    const life = document.createElement('span');
    life.className = 'hero-artwork-life';
    const frames = [0, 1, 2].map(frame => {
      const image = document.createElement('img');
      // Frame 0 is the approved peeking artwork; 1 clings, 2 lets go with arms up.
      image.src = frame === 0
        ? `/lightvela-intl-home/assets/peek-friends/${name}.webp`
        : `/lightvela-intl-home/assets/hero-poses/${name}-${frame}.webp`;
      image.alt = ''; image.width = 512; image.height = 512; image.draggable = false;
      image.hidden = frame !== 0;
      life.append(image);
      return image;
    });
    const waveFrames = [0, 1].map(frame => {
      const image = document.createElement('img');
      image.src = `/lightvela-intl-home/assets/hero-poses/${name}-wave-${frame}.webp`;
      image.alt = ''; image.width = 512; image.height = 512; image.draggable = false;
      image.className = 'hero-artwork-wave'; image.hidden = true;
      life.append(image);
      return image;
    });
    button.append(life); layer.append(button);
    let peek: gsap.core.Timeline | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let waving = false;
    let requested = false;
    let scrollFrame = 0;
    let ready = false;
    const prepared = Promise.all(waveFrames.map(image => image.decode?.().catch(() => {}) ?? Promise.resolve()))
      .then(() => { ready = waveFrames.every(image => image.complete && image.naturalWidth > 0); });
    function showScrollFrame(frame: number) {
      scrollFrame = frame;
      if (!waving) frames.forEach((image, index) => { image.hidden = index !== frame; });
    }
    function endWave() {
      requested = false; waving = false;
      clearInterval(timer); clearTimeout(clickTimer); timer = undefined; clickTimer = undefined;
      waveFrames.forEach(image => { image.hidden = true; });
      showScrollFrame(scrollFrame);
      button.dataset.waving = 'false';
      peek?.kill();
      // Rotation belongs to the scroll lean set in draw(); only undo the hop.
      gsap.set(life, { y: 0 });
    }
    async function greet() {
      if (reduce.matches || progress > .22 || disposed || requested) return;
      requested = true;
      await prepared;
      if (!requested || disposed || reduce.matches || progress > .22 || !ready) { requested = false; return; }
      waving = true; button.dataset.waving = 'true';
      frames.forEach(image => { image.hidden = true; });
      waveFrames.forEach((image, index) => { image.hidden = index !== 0; });
      peek?.kill();
      peek = gsap.timeline().to(life, { y: -10, duration: .24, ease: 'power2.out' });
      let beat = 0;
      timer = setInterval(() => {
        beat++;
        waveFrames.forEach((image, index) => { image.hidden = index !== beat % 2; });
        if (beat >= 6) { clearInterval(timer); timer = undefined; }
      }, 220);
    }
    const enter = () => { void greet(); };
    const leave = () => { if (document.activeElement !== button) endWave(); };
    const click = () => { endWave(); void greet(); clickTimer = setTimeout(endWave, 1750); };
    button.addEventListener('pointerenter', enter);
    button.addEventListener('pointerleave', leave);
    button.addEventListener('focus', enter);
    button.addEventListener('blur', endWave);
    button.addEventListener('click', click);
    return { button, life, showScrollFrame, endWave, stop: () => {
      endWave();
      button.removeEventListener('pointerenter', enter); button.removeEventListener('pointerleave', leave);
      button.removeEventListener('focus', enter); button.removeEventListener('blur', endWave);
      button.removeEventListener('click', click);
    } };

  });
  document.body.append(layer);
  let lastEdge = { top: NaN, left: NaN };
  function syncFrameEntrance() {
    if (!frame) return;
    const edge = frame.querySelector<HTMLElement>('.im') ?? frame;
    const rect = edge.getBoundingClientRect();
    // The chat window slides up during its entrance. Re-anchor the friends and
    // the crop line whenever its border moves, or they sink over the search box.
    const docTop = rect.top + window.scrollY;
    const docLeft = rect.left + window.scrollX;
    if (docTop !== lastEdge.top || docLeft !== lastEdge.left) {
      lastEdge = { top: docTop, left: docLeft };
      draw();
      return;
    }
    // On the way back up the characters used to enter one head-height before
    // the demo window. Wait until its border is actually on screen.
    const falling = !reduce.matches && progress * exitEnd() > gripEnd() * .38 && progress < 1;
    const inView = falling || rect.height === 0 || (rect.top < window.innerHeight - 20 && rect.bottom > 0);
    const opacity = Number.parseFloat(getComputedStyle(frame).opacity);
    const visibility = inView ? 'visible' : 'hidden';
    const targetOpacity = String(falling ? 1 : Number.isFinite(opacity) ? opacity : 1);
    if (layer.style.visibility !== visibility) layer.style.visibility = visibility;
    if (layer.style.opacity !== targetOpacity) layer.style.opacity = targetOpacity;
  }
  const frameObserver = frame ? new MutationObserver(syncFrameEntrance) : undefined;
  if (frameObserver && frame) frameObserver.observe(frame, { attributes: true, attributeFilter: ['style', 'class'] });
  // GSAP can animate computed opacity without a DOM mutation at every tick.
  // Mirror the frame throughout its entrance and when that entrance replays.
  if (frame) gsap.ticker.add(syncFrameEntrance);
  function draw() {
    const mobile = window.innerWidth < 900;
    const frameEdge = frame?.querySelector<HTMLElement>('.im') ?? frame ?? heroElement;
    const frameRect = frameEdge.getBoundingClientRect();
    const end = exitEnd();
    const grip = gripEnd();
    const scrollPosition = progress * end;
    // All four friends perch over the chat window's inner border, with one just
    // spilling past its left edge rather than floating in the page margin.
    // Tuck the entire group inside the chat window, keeping their overlap.
    // The layer lives in document coordinates and scrolls with the page, so the
    // browser itself keeps the friends on the border. Its bottom edge is the crop
    // line. A script chasing a fixed layer always trails a fast scroll by a frame.
    const docTop = frameRect.top + window.scrollY;
    const clusterStart = frameRect.left + window.scrollX - 18;
    actors.forEach(({ button, life, showScrollFrame, endWave }, i) => {
      const spec = CAST[i]!;
      const delay = HERO_DELAYS[i]!;
      const pose = heroPose(progress, delay);
      // The narrow layout needs the tabs and chat header clear of decoration.
      // Reduced motion keeps the friends perched instead of letting them fall.
      const shown = !mobile && (reduce.matches || pose.visible);
      button.hidden = !shown;

      if (!shown) { endWave(); return; }
      if (progress > .22 || reduce.matches) endWave();
      const size = ART[i]![1] * (mobile ? .72 : .8);
      button.style.width = `${size}px`;
      button.style.height = `${size}px`;
      // Shoulder to shoulder with a slight overlap, every face still visible.
      const layout = LAYOUT[i]!;
      button.style.left = `${clusterStart + layout.left}px`;
      button.style.right = 'auto';
      // Crop each original illustration at the frame edge, just below the mouth.
      button.style.top = `${docTop - size * layout.crop / 512}px`;
      button.style.bottom = 'auto';
      button.style.zIndex = String([1, 3, 2, 4][i]);
      // Scroll scrubs a reluctant grip: pull up, cling, then slip. Reverse scroll
      // follows the same path back, so a returning friend catches the edge again.
      const local = clamp((scrollPosition / grip - delay) / (1 - delay));
      const frame = reduce.matches ? 0 : local < .14 ? 0 : local < .48 ? 1 : 2;
      button.dataset.pose = ['grip', 'reluctant', 'arms-up'][frame];
      showScrollFrame(frame);
      // While they still hold on, the friends ride the window edge exactly:
      // the page moving up carries them up with it. Only a small wobble plays
      // in place. Leaving the edge starts once they let go.
      const releaseAt = grip * (delay + (1 - delay) * .38);
      const slip = Math.pow(clamp((scrollPosition - releaseAt) / Math.max(1, end - releaseAt)), 1.5);
      const struggle = Math.sin(local * Math.PI * 16 + i) * Math.sin(Math.PI * clamp((local - .16) / .30));
      const fall = reduce.matches ? 0 : slip;
      const wobble = reduce.matches ? 0 : struggle * (1 - fall);
      const releaseTop = docTop - size * layout.crop / 512 - releaseAt;
      const fallDistance = Math.max(0, window.innerHeight + size * .25 - releaseTop);
      const scrollCompensation = reduce.matches ? 0 : Math.max(0, scrollPosition - releaseAt);
      const drift = Math.min(180 + i * 55, Math.max(0, clusterStart + layout.left - window.scrollX - 16));
      gsap.set(button, { y: scrollCompensation + fall * fallDistance - wobble * 2.5,
        x: -fall * drift + wobble * 2 });
      gsap.set(life, { rotation: [9, -3, 5, -7, -8, 3, -5][i]! + spec.side * fall * 32 + wobble * 1.3 });
      // Each friend hides its body below the border until it lets go itself,
      // so the ones still holding on never spill over the tabs or search box.
      const release = reduce.matches ? 0 : smooth((local - .36) / .1);
      const below = size * (1 - layout.crop / 512);
      button.style.clipPath = `inset(-50% -50% ${below * (1 - release)}px -50%)`;
      button.disabled = progress > .22;
    });
    // The layer's bottom edge is the one crop line, and it belongs to the chat
    // frame rather than to any rotated character. It conceals the original feet
    // while they hold the edge. Reduced motion never lets go, so it never opens;
    // otherwise it opens only as the first friend lets go (its slip starts at
    // .38), so gripping bodies never spill over the tabs and search box.
    const open = reduce.matches ? 0 : smooth((scrollPosition / grip - .36) / .1);
    layer.style.height = `${docTop + open * Math.max(window.innerHeight * 2, end + window.innerHeight + 200 - docTop)}px`;
    syncFrameEntrance();
  }
  const trigger = ScrollTrigger.create({ id: HERO_ARTWORK_TRIGGER_ID, trigger: hero, start: 0,
    end: exitEnd,
    onUpdate: self => { progress = self.progress; draw(); },
    onRefresh: self => { progress = self.progress; draw(); },
  });
  // Keep document-coordinate anchors current even outside the trigger range.
  const follow = () => draw();
  window.addEventListener('scroll', follow, { passive: true });
  document.addEventListener('visibilitychange', draw);
  window.addEventListener('resize', draw);
  reduce.addEventListener('change', draw);
  draw();
  return () => { disposed = true; trigger.kill(); frameObserver?.disconnect();
    if (frame) gsap.ticker.remove(syncFrameEntrance);
    actors.forEach(actor => actor.stop()); layer.remove();
    window.removeEventListener('scroll', follow);
    document.removeEventListener('visibilitychange', draw);
    window.removeEventListener('resize', draw); reduce.removeEventListener('change', draw); };
}
