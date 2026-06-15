import { useEffect, useRef } from 'react';

/**
 * 给容器内所有 .lv-reveal / .lv-reveal-up 元素
 * 在进入视口时加 .lv-revealed
 */
export function useScrollReveal() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const targets = el.querySelectorAll<HTMLElement>('.lv-reveal, .lv-reveal-up');
    if (!targets.length) return;

    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('lv-revealed');
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.04 }
    );

    // 延迟一帧再 observe：确保浏览器先渲染 opacity:0/blur 初始状态，
    // 再触发 transition，避免页面加载时直接跳到 revealed 状态。
    const raf = requestAnimationFrame(() => {
      targets.forEach((t) => obs.observe(t));
    });

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, []);

  return ref;
}
