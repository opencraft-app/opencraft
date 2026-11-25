import { animate } from 'motion/mini';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function enter(element, delay = 0) {
  if (reducedMotion.matches) return;
  animate(
    element,
    { opacity: [0.72, 1], transform: ['translateY(9px)', 'translateY(0)'] },
    { duration: 0.56, ease: [0.22, 1, 0.36, 1], delay },
  );
}

if (!reducedMotion.matches) {
  enter(document.querySelector('.hero-copy'));
  enter(document.querySelector('.hero-art'), 0.07);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        enter(entry.target);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.15 });
    document.querySelectorAll('.benefit-grid article, .start').forEach(element => {
      observer.observe(element);
    });
  }
}

const figure = document.querySelector('.hero-art');
if (!reducedMotion.matches && 'WebGL2RenderingContext' in window && 'ResizeObserver' in window) {
  const preload = async () => {
    try {
      await figure.querySelector('img').decode();
      if (reducedMotion.matches || document.hidden) return;
      const { playHeroLight } = await import('./hero-light.mjs');
      playHeroLight(figure, reducedMotion);
    } catch {
      // The static image is the fallback for unsupported graphics.
    }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(preload, { timeout: 1200 });
  else setTimeout(preload, 250);
}
