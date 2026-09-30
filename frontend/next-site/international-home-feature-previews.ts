import { gsap } from 'gsap';

type Preview = { card: HTMLElement; timeline: gsap.core.Timeline };

export function mountFeaturePreviews(root: HTMLElement): () => void {
  const previews: Preview[] = [];
  const visible = new Set<HTMLElement>();
  let disposed = false;
  let measureFrame = 0;

  root.querySelectorAll<HTMLElement>('.about__cards .wcard').forEach((card) => {
    const cloud = card.querySelector('.wcard__demo--cloud');
    const messages = card.querySelectorAll('.feature-copy-preview span');
    if (!cloud && !messages.length) return;
    const timeline = gsap.timeline({ paused: true, repeat: -1, defaults: { ease: 'power3.out' } });
    if (cloud) {
      timeline.fromTo(cloud, { scale: 1 }, { scale: 1.025, duration: 3.6, ease: 'sine.inOut', immediateRender: false })
        .to(cloud, { scale: 1, duration: 3.6, ease: 'sine.inOut' });
    }
    if (messages.length) {
      timeline.fromTo(messages, { y: 8, opacity: 0 }, {
        y: 0, opacity: 1, duration: 0.45, stagger: 0.65, immediateRender: false,
      }).to(messages, { y: -4, opacity: 0, duration: 0.28, stagger: 0.08 }, '+=3.6');
      timeline.repeatDelay(0.6);
    }
    previews.push({ card, timeline });
  });

  function sync() {
    if (disposed) return;
    previews.forEach(({ card, timeline }) => {
      const running = visible.has(card) && !document.hidden && root.isConnected;
      if (timeline.paused() === running) timeline.paused(!running);
    });
  }

  function measure() {
    if (disposed) return;
    measureFrame = 0;
    previews.forEach(({ card }) => {
      const box = card.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth) visible.add(card);
      else visible.delete(card);
    });
    sync();
  }
  function requestMeasure() {
    if (!disposed && !measureFrame) measureFrame = requestAnimationFrame(measure);
  }

  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    if (disposed) return;
    entries.forEach((entry) => {
      const card = entry.target as HTMLElement;
      if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(card);
      else visible.delete(card);
    });
    sync();
  }, { threshold: 0 });
  previews.forEach(({ card }) => observer?.observe(card));
  if (!observer) {
    measure();
    document.addEventListener('scroll', requestMeasure, true);
    window.addEventListener('resize', requestMeasure);
  }
  const visibility = () => { if (!observer && !document.hidden) measure(); else sync(); };
  document.addEventListener('visibilitychange', visibility);

  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(measureFrame);
    observer?.disconnect();
    previews.forEach(({ timeline }) => timeline.revert());
    visible.clear();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('scroll', requestMeasure, true);
    window.removeEventListener('resize', requestMeasure);
  };
}
