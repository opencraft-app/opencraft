import { useRef, useEffect, useCallback } from "react";

/**
 * 粒子网格 Canvas 动画
 * 参考 GitHub 首页 lp-IntroVisuals-canvas 效果：
 * - 均匀分布的网格点
 * - 点与点之间的淡色连线（按网格邻居连接，O(n) 复杂度）
 * - 鼠标靠近时点被推开 + 波纹扩散
 * - 整体有轻微浮动呼吸感
 * - 尊重 prefers-reduced-motion，离屏时自动暂停
 */

interface Dot {
  /** 网格行/列索引，用于邻居连线查找 */
  row: number;
  col: number;
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
  /** 网格索引：grid[row][col] = dot，用于 O(1) 邻居查找 */
  const gridRef = useRef<Dot[][]>([]);
  const gridSizeRef = useRef({ rows: 0, cols: 0 });
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  /** 是否正在运行动画循环（离屏/减少动画偏好时置 false） */
  const runningRef = useRef(false);
  /** 是否开启了『减少动画』偏好（避免 resize 里再读 matchMedia） */
  const reducedMotionRef = useRef(false);

  /** 初始化网格点 */
  const initDots = useCallback((w: number, h: number) => {
    const dots: Dot[] = [];
    const grid: Dot[][] = [];
    // 计算网格范围，让点均匀铺满画布（含边缘外扩一格，避免边缘空白）
    const cols = Math.ceil(w / GRID_GAP) + 2;
    const rows = Math.ceil(h / GRID_GAP) + 2;
    const offsetX = (w - (cols - 1) * GRID_GAP) / 2;
    const offsetY = (h - (rows - 1) * GRID_GAP) / 2;

    for (let r = 0; r < rows; r++) {
      grid[r] = [];
      for (let c = 0; c < cols; c++) {
        const bx = offsetX + c * GRID_GAP;
        const by = offsetY + r * GRID_GAP;
        const dot: Dot = {
          row: r,
          col: c,
          baseX: bx,
          baseY: by,
          x: bx,
          y: by,
          vx: 0,
          vy: 0,
          radius: DOT_RADIUS,
          currentRadius: DOT_RADIUS,
          phase: Math.random() * Math.PI * 2,
        };
        dots.push(dot);
        grid[r]![c] = dot;
      }
    }
    dotsRef.current = dots;
    gridRef.current = grid;
    gridSizeRef.current = { rows, cols };
  }, []);

  /** 绘制一帧画面（纯渲染，不负责调度） */
  const drawOnce = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    const { w, h, dpr } = sizeRef.current;
    const dots = dotsRef.current;
    const grid = gridRef.current;
    const { rows, cols } = gridSizeRef.current;
    const mouse = mouseRef.current;

    // 每帧重置 transform，避免 resize 时 scale 累积
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    // 绘制连线 — O(n) 按网格邻居连线（每个点只连右、下、右下、左下 4 个方向）
    ctx.lineWidth = 0.5;
    const neighbors: Array<[number, number]> = [
      [0, 1],   // 右
      [1, 0],   // 下
      [1, 1],   // 右下
      [1, -1],  // 左下
    ];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = grid[r]?.[c];
        if (!a) continue;
        for (const [dr, dc] of neighbors) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const b = grid[nr]?.[nc];
          if (!b) continue;

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
  }, []);

  /** 动画主循环 — 由 runningRef 控制启停 */
  const animate = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    if (!runningRef.current) return;
    drawOnce(ctx, time);
    rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
  }, [drawOnce]);

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

    // dpr 存入 ref，由 animate 每帧通过 setTransform 应用，避免缩放耦合
    sizeRef.current = { w, h, dpr };
    initDots(w, h);

    // reducedMotion 场景下动画循环不会跑，这里主动补一帧，避免画面停留在旧尺寸
    if (reducedMotionRef.current) {
      const ctx = canvas.getContext("2d");
      if (ctx) drawOnce(ctx, 0);
    }
  }, [initDots, drawOnce]);

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

    // 尊重用户的"减少动画"偏好：直接渲染一次静态画面，不启动动画循环
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedMotionRef.current = reducedMotion;

    handleResize();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 启动/停止动画循环的工具
    const start = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      rafRef.current = requestAnimationFrame((t) => animate(ctx, t));
    };
    const stop = () => {
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
    };

    if (reducedMotion) {
      // 只绘制一帧静态画面，不启动循环
      drawOnce(ctx, 0);
    } else {
      start();
    }

    // IntersectionObserver：离屏时停止动画，节省 CPU
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          if (!reducedMotion) start();
        } else {
          stop();
        }
      },
      { threshold: 0 }
    );
    observer.observe(canvas);

    // 事件监听
    window.addEventListener("resize", handleResize);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [handleResize, animate, drawOnce, handleMouseMove, handleMouseLeave]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block" }}
    />
  );
}
