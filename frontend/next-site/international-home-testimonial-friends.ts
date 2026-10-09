import { gsap } from 'gsap';
import { watchMascotBeats } from './international-home-mascot-life';

const REDUCED_MOTION_OK_QUERY = '(prefers-reduced-motion: no-preference)';
const HOVER_FINE_QUERY = '(hover: hover) and (pointer: fine)';

// Unequal sizes, overlapping heights and depth make two little peeking crowds.
// Base pose belongs to the slot; GSAP touches only its inner artwork.
const FRIENDS = [
  ['bean-lilac', 'left', 20, 136, 29, -36, 1],
  ['round-coral', 'left', 37, 180, 38, -72, 3],
  ['square-mint', 'left', 55, 148, 27, -40, 2],
  ['drop-sky', 'left', 73, 166, 35, -46, 4],
  ['cloud-butter', 'right', 25, 154, -31, -42, 1],
  ['round-peach', 'right', 46, 186, -38, -73, 3],
  ['bean-periwinkle', 'right', 68, 158, -27, -62, 2],
] as const;

/** Decorative side cast remains visible and still when reduced motion is enabled. */
export function mountTestimonialFriends(root: HTMLElement): () => void {
  const section = root.querySelector<HTMLElement>('.voice');
  if (!section || section.querySelector('.home-testimonial-friends')) return () => {};
  const layer = document.createElement('div');
  layer.className = 'home-testimonial-friends';
  layer.setAttribute('aria-hidden', 'true');
  const actors = FRIENDS.map(([name, side, top, size, angle, edge, depth], index) => {
    const slot = document.createElement('span');
    slot.className = `home-testimonial-friend home-testimonial-friend--${side}`;
    slot.style.top = `${top}%`;
    slot.style.setProperty('--peek-size', `${size}px`);
    slot.style.setProperty('--peek-angle', `${angle}deg`);
    slot.style.setProperty('--peek-edge', `${edge}px`);
    slot.style.zIndex = String(depth);
    slot.dataset.friend = name;
    slot.dataset.slot = String(index);
    const image = document.createElement('img');
    image.src = `/lightvela-intl-home/assets/peek-friends/${name}.webp`;
    image.alt = '';
    image.width = 512;
    image.height = 512;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    slot.append(image);
    layer.append(slot);
    return { slot, image, side, index };
  });
  section.append(layer);
  section.classList.add('has-peek-friends');
  const media = gsap.matchMedia();
  media.add(REDUCED_MOTION_OK_QUERY, () => {
    const beats = actors.map(({ slot, image, side, index }) => {
      const direction = side === 'left' ? 1 : -1;
      // A rear friend peeks first, the front friend answers; each then rests visibly.
      const rhythm = [
        { delay: 0.12, reach: 23, look: 0.75, rest: 2.6, turn: 3 },
        { delay: 0.62, reach: 28, look: 0.4, rest: 2.2, turn: 4 },
        { delay: 1.05, reach: 21, look: 0.95, rest: 2.9, turn: -3 },
        { delay: 0.35, reach: 25, look: 0.55, rest: 2.35, turn: 3.5 },
        { delay: 0.3, reach: 22, look: 0.85, rest: 3.1, turn: -3 },
        { delay: 0.82, reach: 29, look: 0.45, rest: 2.45, turn: 4 },
        { delay: 1.2, reach: 24, look: 0.65, rest: 2.75, turn: 3 },
      ][index]!;
      const settled = { x: direction * ((index % 3) - 1) * 2, y: index % 2 ? 1 : -1, rotation: direction * (index % 2 ? -0.9 : 0.7) };
      const tucked = { x: -direction * rhythm.reach, y: 4, rotation: -direction * 4, scaleX: 0.985, scaleY: 1.015 };
      const timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.15 });
      timeline.fromTo(image, tucked, {
        x: direction * 8, y: -4, rotation: direction * rhythm.turn,
        scaleX: 1, scaleY: 1, duration: 0.72, ease: 'power2.out',
      }, rhythm.delay)
        .to(image, { x: direction * 12, y: -2, rotation: -direction, duration: 0.4, ease: 'sine.inOut' }, `+=${rhythm.look}`)
        .to(image, { y: 2, rotation: direction * rhythm.turn * 0.5, scaleX: 1.018, scaleY: 0.982, duration: 0.2, ease: 'sine.in' })
        .to(image, { y: -3, rotation: direction * rhythm.turn, scaleX: 0.99, scaleY: 1.01, duration: 0.32, ease: 'sine.out' })
        .to(image, { ...settled, scaleX: 1, scaleY: 1, duration: 0.6, ease: 'sine.inOut' })
        .to(image, { y: settled.y - 1.5, scaleX: 0.993, scaleY: 1.015, duration: 0.65, ease: 'sine.inOut' }, `+=${rhythm.rest}`)
        .to(image, { ...settled, scaleX: 1, scaleY: 1, duration: 0.6, ease: 'sine.inOut' })
        .to(image, { ...tucked, duration: 0.65, ease: 'power1.inOut' }, '+=0.2');
      return { observe: slot, surface: image, timeline, interact: image };
    });
    return watchMascotBeats(beats, window.matchMedia(HOVER_FINE_QUERY).matches);
  });
  return () => { media.revert(); layer.remove(); section.classList.remove('has-peek-friends'); };
}
