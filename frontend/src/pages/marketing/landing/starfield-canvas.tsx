import { useRef, useEffect, useCallback } from "react";

/**
 * Flask.do 风格三角形光束 + 星光 Canvas
 *
 * 从顶部中心一个点发射出锥形光束向下扩散，
 * 类似聚光灯效果。多层三角形叠加 + 高斯模糊实现柔和边缘。
 *
 * 入场动画：光束从顶部光源点逐渐向下"扫射/展开"，
 * 参考 GitHub 首页的光束照射下来的效果。
 */

interface Star {
  x: number;
  y: number;
  radius: number;
  phase: number;
  speed: number;
  maxAlpha: number;
  minAlpha: number;
  isBig: boolean;
}

const STAR_COUNT = 45;
const BIG_STAR_COUNT = 6;

/** 入场动画持续时间（毫秒） */
const REVEAL_DURATION = 2000;
/** 入场动画延迟（毫秒），等页面其他元素先出现 */
const REVEAL_DELAY = 600;

/** easeOutCubic 缓动函数 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function StarfieldCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<Star[]>([]);
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  /** 入场动画进度 0→1 */
  const revealRef = useRef(0);
  /** 动画开始时间戳 */
  const entryStartRef = useRef(0);

  /** 初始化星星 — 分布在三角形光束锥体内 */
  const initStars = useCallback((w: number, h: number) => {
    const stars: Star[] = [];
    const cx = w / 2;

    for (let i = 0; i < STAR_COUNT + BIG_STAR_COUNT; i++) {
      const isBig = i >= STAR_COUNT;

      // 星星沿三角形锥体分布：越往下越宽
      const yRatio = Math.random(); // 0=顶部, 1=底部
      const y = yRatio * h;

      // 三角形宽度随 y 线性增长（顶部窄，底部宽）
      const beamHalfWidth = yRatio * w * 0.42;
      const x = cx + (Math.random() - 0.5) * 2 * beamHalfWidth;

      // 越靠近中心轴和顶部越亮
      const xDist = Math.abs(x - cx) / (beamHalfWidth || 1);
      const brightnessBoost = Math.max(0.15, (1 - xDist * 0.7) * (1 - yRatio * 0.4));

      stars.push({
        x: Math.max(0, Math.min(w, x)),
        y: Math.max(0, Math.min(h, y)),
        radius: isBig ? Math.random() * 1.5 + 1.0 : Math.random() * 0.8 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.0012 + 0.0003,
        maxAlpha: isBig
          ? (Math.random() * 0.3 + 0.5) * brightnessBoost
          : (Math.random() * 0.25 + 0.1) * brightnessBoost,
        minAlpha: 0.01,
        isBig,
      });
    }

    starsRef.current = stars;
  }, []);

  /**
   * 绘制三角形锥形光束
   * revealH: 当前展开到的 Y 坐标（入场动画用，0=只有光源点，h=完全展开）
   */
  const drawBeam = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, pulse: number, revealH: number) => {
    const cx = w / 2;
    const pulseAlpha = 0.92 + 0.08 * pulse;

    // 光束参数
    const tipY = 0;                    // 光源点 Y（顶部）
    const baseY = revealH;             // 光束当前展开到的底部（入场动画控制）
    const fullBaseHalfW = w * 0.44;    // 完全展开时的底部半宽
    // 当前展开比例下的底部半宽（线性缩放）
    const ratio = h > 0 ? revealH / h : 0;
    const baseHalfW = fullBaseHalfW * ratio;

    // 入场未开始时只画光源点
    if (revealH < 2) {
      // 入场未开始时只画光源点
      const g6c = ctx.createRadialGradient(cx, tipY, 0, cx, tipY, 4);
      g6c.addColorStop(0, `rgba(235, 240, 255, ${0.70 * pulseAlpha * ratio})`);
      g6c.addColorStop(1, "rgba(193, 204, 255, 0)");      ctx.fillStyle = g6c;
      ctx.beginPath();
      ctx.arc(cx, tipY, 4, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // ── 第1层：最外层光晕（大模糊，营造氛围） ──
    ctx.save();
    ctx.filter = "blur(40px)";
    const g1 = ctx.createLinearGradient(cx, tipY, cx, baseY);
    g1.addColorStop(0, `rgba(13, 85, 255, ${0.18 * pulseAlpha})`);
    g1.addColorStop(0.25, `rgba(40, 93, 255, ${0.12 * pulseAlpha})`);
    g1.addColorStop(0.55, `rgba(170, 127, 255, ${0.06 * pulseAlpha})`);
    g1.addColorStop(1, "rgba(15, 83, 255, 0)");
    ctx.fillStyle = g1;
    ctx.beginPath();
    ctx.moveTo(cx, tipY - 10);
    ctx.lineTo(cx - baseHalfW * 1.15, baseY);
    ctx.lineTo(cx + baseHalfW * 1.15, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── 第2层：主光束三角形（中等模糊） ──
    ctx.save();
    ctx.filter = "blur(20px)";
    const g2 = ctx.createLinearGradient(cx, tipY, cx, baseY);
    g2.addColorStop(0, `rgba(193, 204, 255, ${0.22 * pulseAlpha})`);
    g2.addColorStop(0.15, `rgba(168, 183, 255, ${0.15 * pulseAlpha})`);
    g2.addColorStop(0.4, `rgba(40, 93, 255, ${0.08 * pulseAlpha})`);
    g2.addColorStop(0.7, `rgba(170, 127, 255, ${0.03 * pulseAlpha})`);
    g2.addColorStop(1, "rgba(15, 83, 255, 0)");
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.moveTo(cx, tipY - 5);
    ctx.lineTo(cx - baseHalfW * 0.85, baseY);
    ctx.lineTo(cx + baseHalfW * 0.85, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── 第3层：内层光束（更窄更亮，轻微模糊） ──
    ctx.save();
    ctx.filter = "blur(12px)";
    const g3 = ctx.createLinearGradient(cx, tipY, cx, baseY);
    g3.addColorStop(0, `rgba(210, 215, 255, ${0.22 * pulseAlpha})`);
    g3.addColorStop(0.2, `rgba(168, 183, 255, ${0.13 * pulseAlpha})`);
    g3.addColorStop(0.5, `rgba(40, 93, 255, ${0.06 * pulseAlpha})`);
    g3.addColorStop(0.8, `rgba(170, 127, 255, ${0.02 * pulseAlpha})`);
    g3.addColorStop(1, "rgba(15, 83, 255, 0)");
    ctx.fillStyle = g3;
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - baseHalfW * 0.5, baseY);
    ctx.lineTo(cx + baseHalfW * 0.5, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── 第4层：核心光柱（最窄最亮的中心线） ──
    ctx.save();
    ctx.filter = "blur(8px)";
    const g4 = ctx.createLinearGradient(cx, tipY, cx, baseY);
    g4.addColorStop(0, `rgba(220, 225, 255, ${0.20 * pulseAlpha})`);
    g4.addColorStop(0.25, `rgba(193, 204, 255, ${0.11 * pulseAlpha})`);
    g4.addColorStop(0.55, `rgba(40, 93, 255, ${0.04 * pulseAlpha})`);
    g4.addColorStop(1, "rgba(15, 83, 255, 0)");
    ctx.fillStyle = g4;
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - baseHalfW * 0.18, baseY);
    ctx.lineTo(cx + baseHalfW * 0.18, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ── 第5层：光束边缘线（左右两条微弱的边缘高光线） ──
    ctx.save();
    ctx.filter = "blur(4px)";
    ctx.strokeStyle = `rgba(168, 183, 255, ${0.08 * pulseAlpha})`;
    ctx.lineWidth = 1.5;
    // 左边缘
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - baseHalfW * 0.82, baseY);
    ctx.stroke();
    // 右边缘
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx + baseHalfW * 0.82, baseY);
    ctx.stroke();
    ctx.restore();

    // ── 第6层：顶部光源亮点（发射点） ──
    // 外层光晕
    ctx.save();
    ctx.filter = "blur(15px)";
    const g6a = ctx.createRadialGradient(cx, tipY, 0, cx, tipY, 50);
    g6a.addColorStop(0, `rgba(193, 204, 255, ${0.35 * pulseAlpha})`);
    g6a.addColorStop(0.4, `rgba(40, 93, 255, ${0.18 * pulseAlpha})`);
    g6a.addColorStop(1, "rgba(15, 83, 255, 0)");
    ctx.fillStyle = g6a;
    ctx.beginPath();
    ctx.arc(cx, tipY, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 内层亮核
    ctx.save();
    ctx.filter = "blur(4px)";
    const g6b = ctx.createRadialGradient(cx, tipY, 0, cx, tipY, 15);
    g6b.addColorStop(0, `rgba(220, 225, 255, ${0.50 * pulseAlpha})`);
    g6b.addColorStop(0.5, `rgba(168, 183, 255, ${0.25 * pulseAlpha})`);
    g6b.addColorStop(1, "rgba(40, 93, 255, 0)");
    ctx.fillStyle = g6b;
    ctx.beginPath();
    ctx.arc(cx, tipY, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 最亮的核心点
    const g6c = ctx.createRadialGradient(cx, tipY, 0, cx, tipY, 4);
    g6c.addColorStop(0, `rgba(235, 240, 255, ${0.70 * pulseAlpha})`);
    g6c.addColorStop(1, "rgba(193, 204, 255, 0)");
    ctx.fillStyle = g6c;
    ctx.beginPath();
    ctx.arc(cx, tipY, 4, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  /** 绘制星星（只显示在已展开区域内的星星） */
  const drawStars = useCallback((ctx: CanvasRenderingContext2D, time: number, revealH: number) => {
    const stars = starsRef.current;

    for (const star of stars) {
      if (!star) continue;

      // 入场动画：只显示在已展开区域内的星星
      if (star.y > revealH) continue;

      // 靠近展开边缘的星星逐渐淡入（边缘 30px 内渐变）
      const edgeFade = revealH > 30 ? Math.min(1, (revealH - star.y) / 30) : 1;

      const flicker = Math.sin(time * star.speed + star.phase);
      const alpha = (star.minAlpha + (star.maxAlpha - star.minAlpha) * ((flicker + 1) / 2)) * edgeFade;

      if (alpha < 0.005) continue;

      if (star.isBig) {
        // 十字星芒
        const size = star.radius;
        ctx.save();
        ctx.filter = "blur(1px)";
        const crossGrad = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, size * 5);
        crossGrad.addColorStop(0, `rgba(168, 183, 255, ${alpha * 0.35})`);
        crossGrad.addColorStop(1, "rgba(168, 183, 255, 0)");
        ctx.fillStyle = crossGrad;
        ctx.beginPath();
        ctx.ellipse(star.x, star.y, size * 5, size * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(star.x, star.y, size * 0.3, size * 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 星星核心
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = star.isBig
        ? `rgba(193, 204, 255, ${alpha})`
        : `rgba(168, 183, 255, ${alpha * 0.85})`;
      ctx.fill();

      // 柔和光晕
      if (star.radius > 0.5) {
        const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.radius * 4);
        glow.addColorStop(0, `rgba(40, 93, 255, ${alpha * 0.2})`);
        glow.addColorStop(1, "rgba(40, 93, 255, 0)");
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius * 4, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      }
    }
  }, []);

  /** 动画主循环 */
  const animate = useCallback(
    (ctx: CanvasRenderingContext2D, time: number) => {
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      // ── 入场动画进度计算 ──
      if (entryStartRef.current === 0) {
        entryStartRef.current = time;
      }
      const elapsed = time - entryStartRef.current;
      if (elapsed < REVEAL_DELAY) {
        // 延迟期间不绘制，等待其他元素先出现
        rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
        return;
      }
      const animElapsed = elapsed - REVEAL_DELAY;
      const rawProgress = Math.min(1, animElapsed / REVEAL_DURATION);
      revealRef.current = easeOutCubic(rawProgress);

      // 当前展开到的 Y 坐标
      const revealH = revealRef.current * h;

      // 整体透明度（入场前 20% 快速淡入到 1）
      const globalAlpha = Math.min(1, rawProgress * 5);
      ctx.globalAlpha = globalAlpha;

      const pulse = Math.sin(time * 0.0004);

      drawBeam(ctx, w, h, pulse, revealH);
      drawStars(ctx, time, revealH);

      ctx.globalAlpha = 1;

      rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
    },
    [drawBeam, drawStars],
  );

  /** 处理 resize */
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
    }

    sizeRef.current = { w, h };
    initStars(w, h);
  }, [initStars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    handleResize();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", handleResize);
    };
  }, [handleResize, animate]);

  return <canvas ref={canvasRef} className={className} style={{ display: "block" }} />;
}
