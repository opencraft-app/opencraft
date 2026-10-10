import { gsap } from 'gsap';

type MascotBeat = {
  observe: HTMLElement;
  surface: HTMLElement;
  timeline: gsap.core.Timeline;
  interact?: HTMLElement;
};

/** One visibility owner for each decorative animation; no scroll polling. */
export function watchMascotBeats(beats: MascotBeat[], hover: boolean): () => void {
  const visible = new Set<MascotBeat>();
  const cleanups: Array<() => void> = [];
  const stop = (beat: MascotBeat, rewind: boolean) => {
    if (rewind) beat.timeline.pause(0);
    else beat.timeline.pause();
    beat.surface.style.removeProperty('will-change');
    beat.surface.dataset.mascotPlaying = 'false';
  };
  const play = (beat: MascotBeat, restart: boolean) => {
    if (document.hidden || !visible.has(beat)) return;
    beat.surface.style.willChange = 'transform';
    beat.surface.dataset.mascotPlaying = 'true';
    if (restart) beat.timeline.restart();
    else beat.timeline.resume();
  };
  // Older browsers retain the static artwork without an unbounded fallback loop.
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const beat = beats.find((candidate) => candidate.observe === entry.target);
      if (!beat) continue;
      if (entry.isIntersecting) {
        if (!visible.has(beat)) { visible.add(beat); play(beat, true); }
      } else { visible.delete(beat); stop(beat, true); }
    }
  }, { threshold: 0.12 });
  beats.forEach((beat) => {
    beat.timeline.pause(0);
    beat.surface.dataset.mascotPlaying = 'false';
    observer?.observe(beat.observe);
    if (!hover || !beat.interact) return;
    let lastGreeting = -Infinity;
    const greet = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden || !visible.has(beat)) return;
      const now = performance.now();
      if (now - lastGreeting < 1200) return;
      lastGreeting = now;
      play(beat, true);
    };
    beat.interact.addEventListener('pointerenter', greet);
    cleanups.push(() => beat.interact?.removeEventListener('pointerenter', greet));
  });
  const onVisibility = () => visible.forEach((beat) => document.hidden ? stop(beat, false) : play(beat, false));
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    cleanups.forEach((cleanup) => cleanup());
    beats.forEach((beat) => {
      beat.timeline.kill();
      beat.surface.style.removeProperty('will-change');
      delete beat.surface.dataset.mascotPlaying;
    });
    visible.clear();
  };
}

export function mountMascotLife(root: HTMLElement, { hover }: { desktop: boolean; hover: boolean }): () => void {
  const beats: MascotBeat[] = [];
  const restore: Array<() => void> = [];
  const wrap = (selector: string, kind: string) => {
    const image = root.querySelector<HTMLImageElement>(selector);
    if (!image?.parentNode) return;
    const surface = document.createElement('span');
    surface.className = `home-mascot-life home-mascot-life--${kind}`;
    const originalStyle = image.getAttribute('style');
    image.before(surface);
    surface.append(image);
    image.style.pointerEvents = 'auto';
    restore.push(() => {
      surface.before(image);
      surface.remove();
      if (originalStyle === null) image.removeAttribute('style');
      else image.setAttribute('style', originalStyle);
    });
    return { image, surface };
  };
  // The hero ribbon rider stays static so its ribbon keeps meeting the headline underline.
  const duo = wrap('.scenes__mascot img', 'duo');
  if (duo) {
    // Keep the laptop and both characters intact; two unequal beats suggest a reply.
    const timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 4.6 });
    timeline.fromTo(duo.surface, { x: 0, y: 0, rotation: 0 }, { x: -1, y: -3, rotation: -0.3, duration: 0.5, ease: 'sine.out' }, 0.45)
      .to(duo.surface, { x: 0, y: 0, rotation: 0, duration: 0.5, ease: 'sine.inOut' }, '+=0.18')
      .to(duo.surface, { x: 1, y: -2, rotation: 0.2, duration: 0.35, ease: 'sine.out' }, '+=0.3')
      .to(duo.surface, { x: 0, y: 0, rotation: 0, duration: 0.5, ease: 'sine.inOut' })
      .to(duo.surface, { y: -1.2, duration: 0.9, ease: 'sine.inOut' }, '+=0.6')
      .to(duo.surface, { y: 0, duration: 0.9, ease: 'sine.inOut' });
    beats.push({ observe: duo.image, surface: duo.surface, timeline, interact: duo.image });
  }
  const stop = watchMascotBeats(beats, hover);
  return () => { stop(); restore.forEach((cleanup) => cleanup()); };
}
