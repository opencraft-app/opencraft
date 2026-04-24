import { useRef, useEffect, useCallback } from "react";

/**
 * 粒子网格 Canvas 动画
 * 参考 GitHub 首页 lp-IntroVisuals-canvas 效果：
 * - 均匀分布的网格点
 * - 点与点之间的淡色连线
 * - 鼠标靠近时点被推开 + 波纹扩散
 * - 整体有轻微浮动呼吸感
 */

interface Dot {
  /** 网格基准位置 */
  baseX: number;
  baseY: number;
  /** 当前实际位置 */
  x: number;
  y: number;
  /** 速度（用于弹性回弹） */
  vx: number;
  vy: number;
  /** 基础半径 */
  radius: number;
  /** 当前半径（鼠标靠近时放大） */
  currentRadius: number;
  /** 浮动相位偏移 */
  phase: number;
}

/** 网格间距 */
const GRID_GAP = 48;
/** 鼠标影响半径 */
const MOUSE_RADIUS = 160;
/** 鼠标推力强度 */
const MOUSE_FORCE = 18;
/** 弹性回弹系数（0~1，越小越慢） */
const SPRING = 0.04;
/** 阻尼系数 */
const DAMPING = 0.85;
/** 连线最大距离 */
const LINE_MAX_DIST = GRID_GAP * 1.5;
/** 点的基础半径 */
const DOT_RADIUS = 1.5;
/** 浮动幅度 */
const FLOAT_AMP = 2;
/** 浮动速度 */
const FLOAT_SPEED = 0.0008;

export function ParticleGridCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Dot[]>([]);
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0 });

  /** 初始化网格点 */
  const initDots = useCallback((w: number, h: number) => {
    const dots: Dot[] = [];
    // 计算网格范围，让点均匀铺满画布（含边缘外扩一格，避免边缘空白）
    const cols = Math.ceil(w / GRID_GAP) + 2;
    const rows = Math.ceil(h / GRID_GAP) + 2;
    const offsetX = (w - (cols - 1) * GRID_GAP) / 2;
    const offsetY = (h - (rows - 1) * GRID_GAP) / 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bx = offsetX + c * GRID_GAP;
        const by = offsetY + r * GRID_GAP;
        dots.push({
          baseX: bx,
          baseY: by,
          x: bx,
          y: by,
          vx: 0,
          vy: 0,
          radius: DOT_RADIUS,
          currentRadius: DOT_RADIUS,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
    dotsRef.current = dots;
  }, []);

  /** 动画主循环 */
  const animate = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    const { w, h } = sizeRef.current;
    const dots = dotsRef.current;
    const mouse = mouseRef.current;

    ctx.clearRect(0, 0, w, h);

    // 更新每个点的位置
    for (const dot of dots) {
      // 浮动呼吸
      const floatX = Math.sin(time * FLOAT_SPEED + dot.phase) * FLOAT_AMP;
      const floatY = Math.cos(time * FLOAT_SPEED * 0.7 + dot.phase + 1) * FLOAT_AMP;

      // 目标位置 = 基准 + 浮动
      const targetX = dot.baseX + floatX;
      const targetY = dot.baseY + floatY;

      // 鼠标推力
      const dx = dot.x - mouse.x;
      const dy = dot.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < MOUSE_RADIUS && dist > 0) {
        const force = (1 - dist / MOUSE_RADIUS) * MOUSE_FORCE;
        const angle = Math.atan2(dy, dx);
        dot.vx += Math.cos(angle) * force * 0.15;
        dot.vy += Math.sin(angle) * force * 0.15;
        // 鼠标靠近时点变大
        dot.currentRadius = DOT_RADIUS + (3 - DOT_RADIUS) * (1 - dist / MOUSE_RADIUS);
      } else {
        dot.currentRadius += (DOT_RADIUS - dot.currentRadius) * 0.1;
      }

      // 弹性回弹到目标位置
      dot.vx += (targetX - dot.x) * SPRING;
      dot.vy += (targetY - dot.y) * SPRING;
      dot.vx *= DAMPING;
      dot.vy *= DAMPING;
      dot.x += dot.vx;
      dot.y += dot.vy;
    }

    // 绘制连线（只连接相邻的点）
    ctx.strokeStyle = "rgba(0, 0, 0, 0.04)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i];
        const b = dots[j];
        if (!a || !b) continue;
        // 先用基准位置快速过滤（避免遍历所有点对）
        const baseDx = Math.abs(a.baseX - b.baseX);
        const baseDy = Math.abs(a.baseY - b.baseY);
        if (baseDx > GRID_GAP * 1.1 || baseDy > GRID_GAP * 1.1) continue;

        const ddx = a.x - b.x;
        const ddy = a.y - b.y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < LINE_MAX_DIST) {
          const alpha = 0.04 * (1 - d / LINE_MAX_DIST);
          ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // 绘制点
    for (const dot of dots) {
      // 根据与鼠标距离调整透明度
      const dx = dot.x - mouse.x;
      const dy = dot.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = dist < MOUSE_RADIUS
        ? 0.15 + 0.45 * (1 - dist / MOUSE_RADIUS)
        : 0.15;

      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.currentRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
  }, []);

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
    initDots(w, h);
  }, [initDots]);

  /** 鼠标移动 */
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  /** 鼠标离开 */
  const handleMouseLeave = useCallback(() => {
    mouseRef.current = { x: -9999, y: -9999 };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    handleResize();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    rafRef.current = requestAnimationFrame((t) => animate(ctx, t));

    // 事件监听
    window.addEventListener("resize", handleResize);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [handleResize, animate, handleMouseMove, handleMouseLeave]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block" }}
    />
  );
}
