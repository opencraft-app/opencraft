import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { mountDoorPeek } from './international-home-door-peek';

type StageOptions = { desktop: boolean; hover: boolean };

export function mountStageMotion(root: HTMLElement, { desktop, hover }: StageOptions): () => void {
  gsap.registerPlugin(ScrollTrigger);
  const decorations: HTMLElement[] = [];
  const animations: gsap.core.Animation[] = [];
  const paused = new Set<gsap.core.Animation>();
  const cleanups: Array<() => void> = [];
  let disposed = false;
  const query = (selector: string) => root.querySelector<HTMLElement>(selector);
  const remember = <T extends gsap.core.Animation>(animation: T) => { animations.push(animation); return animation; };
  const decorate = (parent: HTMLElement, className: string) => {
    const element = document.createElement('span');
    element.className = className;
    element.setAttribute('aria-hidden', 'true');
    parent.appendChild(element);
    decorations.push(element);
    return element;
  };

  const hero = query('.hero');
  if (hero) {
    const whitespace = new Map<Text, string>();
    const normalizeWords = () => {
      if (disposed) return;
      hero.querySelectorAll('.hero__line--main .hero__char').forEach((character) => {
        const text = character.firstChild;
        if (text instanceof Text && text.data.includes('\u00a0')) {
          if (!whitespace.has(text)) whitespace.set(text, text.data);
          text.data = text.data.replaceAll('\u00a0', ' ');
        }
      });
    };
    normalizeWords();
    const observer = new MutationObserver(normalizeWords);
    const headline = hero.querySelector('.hero__line--main');
    if (headline) observer.observe(headline, { childList: true, subtree: true });
    cleanups.push(() => {
      observer.disconnect();
      whitespace.forEach((value, node) => { node.data = value; });
      whitespace.clear();
    });
    const intro = remember(gsap.timeline({
      defaults: { ease: 'power3.out' },
      scrollTrigger: { trigger: hero, start: 'top 85%', toggleActions: 'play none none none' },
    }));
    const pieces = [
      ['.hero__eyebrow', 0.05, 16],
      ['.hero__line--main', 0.12, desktop ? 40 : 22],
      ['.hero__line--dynamic', 0.28, 26],
      ['.hero__cta', 0.42, 22],
      ['.hero__frame', 0.5, desktop ? 64 : 24],
    ] as const;
    for (const [selector, at, y] of pieces) {
      const element = query(selector);
      if (!element) continue;
      intro.fromTo(element, { y, opacity: 0.15, scale: selector === '.hero__frame' ? 0.96 : 1 }, {
        y: 0, opacity: 1, scale: 1, duration: desktop ? 0.85 : 0.6,
        immediateRender: false, clearProps: 'transform,opacity',
      }, at);
    }
    const mascot = query('.home-cover-mascot');
    if (mascot) intro.fromTo(mascot, { x: 32, y: -22, rotation: -9, opacity: 0 }, {
      x: 0, y: 0, rotation: 0, opacity: 1, duration: 0.85, ease: 'back.out(1.35)',
      immediateRender: false, clearProps: 'transform,opacity',
    }, 0.5);
  }

  for (const selector of ['.about__head .k', '.scenes__title', '.deploy__lead']) {
    const heading = query(selector);
    if (!heading) continue;
    remember(gsap.fromTo(heading, { y: desktop ? 32 : 18, opacity: 0.15 }, {
      y: 0, opacity: 1, duration: 0.7, ease: 'power3.out', immediateRender: false,
      clearProps: 'transform,opacity', scrollTrigger: { trigger: heading, start: 'top 90%', toggleActions: 'play none none none' },
    }));
  }

  const duo = query('.scenes__mascot img');
  const scenes = query('.scenes');
  if (duo && scenes) {
    remember(gsap.fromTo(duo, { x: desktop ? 45 : 12, y: 22, rotation: -7, opacity: 0.2 }, {
      x: 0, y: 0, rotation: 0, opacity: 1, duration: 0.9, ease: 'back.out(1.15)', immediateRender: false,
      clearProps: 'transform,opacity', scrollTrigger: { trigger: duo, start: 'top 90%', toggleActions: 'play none none none' },
    }));
  }

  const step = query('.home-step-mascot img');
  const stepTrigger = query('.home-step-mascot');
  const deploy = query('.deploy');
  if (step && stepTrigger && deploy) {
    const journey = remember(gsap.timeline({ scrollTrigger: desktop ? {
      trigger: stepTrigger, start: 'top 90%', end: 'top 42%', scrub: 0.45,
    } : { trigger: step, start: 'top 88%', toggleActions: 'play none none none' } }));
    journey.fromTo(step, { x: desktop ? -78 : -18, y: 0 }, {
      x: desktop ? -32 : -7, y: desktop ? -30 : -12, duration: 0.48, ease: 'power1.out', immediateRender: false,
    }).to(step, { x: 0, y: 0, duration: 0.52, ease: 'power2.inOut' });
    const badges = deploy.querySelectorAll('.track__badge');
    const track = query('.track');
    if (badges.length && track) {
      remember(gsap.fromTo(badges, { y: 12, scale: 0.88, opacity: 0.45 }, {
        y: 0, scale: 1, opacity: 1, stagger: 0.14, duration: 0.45, ease: 'back.out(1.2)', immediateRender: false,
        clearProps: 'transform,opacity', scrollTrigger: { trigger: track, start: 'top 85%', toggleActions: 'play none none none' },
      }));
    }
  }

  const cta = query('.cta');
  const ctaTrigger = query('.home-cta-mascot');
  const ctaMascot = query('.home-cta-mascot img');
  if (cta && ctaTrigger && ctaMascot) {
    const glow = decorate(cta, 'home-cta-light');
    const reveal = remember(gsap.timeline({ scrollTrigger: { trigger: ctaTrigger, start: 'top 90%', toggleActions: 'play none none none' } }));
    reveal.fromTo(ctaMascot, { y: 38, rotation: 6, opacity: 0 }, {
      y: -7, rotation: -4, opacity: 1, duration: 0.5, ease: 'power3.out', immediateRender: false,
    }).to(ctaMascot, { y: 0, rotation: 0, duration: 0.4, ease: 'back.out(1.5)', clearProps: 'transform,opacity' })
      .fromTo(glow, { opacity: 0, scale: 0.7 }, { opacity: 0.55, scale: 1.05, duration: 0.7, immediateRender: false }, 0.15)
      .to(glow, { opacity: 0, duration: 0.65 }, 0.9);
  }

  const portal = query('.home-footer-boundary');
  if (portal) cleanups.push(mountDoorPeek(portal));

  if (desktop && hover) {
    root.querySelectorAll<HTMLElement>('.about__cards .wcard').forEach((card) => {
      const inner = card.querySelector<HTMLElement>('.wcard__inner');
      if (!inner) return;
      const sheen = decorate(inner, 'home-card-sheen');
      gsap.set(inner, { transformPerspective: 1000 });
      const rotateX = gsap.quickTo(inner, 'rotationX', { duration: 0.45, ease: 'power3.out' });
      const rotateY = gsap.quickTo(inner, 'rotationY', { duration: 0.45, ease: 'power3.out' });
      const shiftX = gsap.quickTo(sheen, 'x', { duration: 0.45, ease: 'power3.out' });
      const shiftY = gsap.quickTo(sheen, 'y', { duration: 0.45, ease: 'power3.out' });
      animations.push(rotateX.tween, rotateY.tween, shiftX.tween, shiftY.tween);
      const reveal = remember(gsap.to(sheen, { opacity: 0.85, duration: 0.25, paused: true }));
      const move = (event: PointerEvent) => {
        if (event.pointerType === 'touch' || document.hidden) return;
        const rect = card.getBoundingClientRect();
        const x = gsap.utils.clamp(-0.5, 0.5, (event.clientX - rect.left) / rect.width - 0.5);
        const y = gsap.utils.clamp(-0.5, 0.5, (event.clientY - rect.top) / rect.height - 0.5);
        rotateX(-y * 8); rotateY(x * 10);
        shiftX(x * rect.width * 0.65); shiftY(y * rect.height * 0.65);
        reveal.play();
      };
      const reset = () => { rotateX(0); rotateY(0); reveal.reverse(); };
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerleave', reset);
      card.addEventListener('keydown', reset);
      cleanups.push(() => {
        card.removeEventListener('pointermove', move);
        card.removeEventListener('pointerleave', reset);
        card.removeEventListener('keydown', reset);
      });
    });
  }

  const visibility = () => {
    if (document.hidden) animations.forEach((animation) => {
      if (animation.isActive()) { paused.add(animation); animation.pause(); }
    });
    else { paused.forEach((animation) => animation.resume()); paused.clear(); }
  };
  document.addEventListener('visibilitychange', visibility);
  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('visibilitychange', visibility);
    cleanups.forEach((cleanup) => cleanup());
    animations.forEach((animation) => { animation.scrollTrigger?.kill(); animation.kill(); });
    decorations.forEach((decoration) => decoration.remove());
    paused.clear();
  };
}
