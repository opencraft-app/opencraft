import { useRef, useState, useCallback } from 'react';
import { imgHeroBgNew, imgHeroElement01, imgHeroElement02, imgHeroElement03, imgHeroAvatars } from '../assets';
import '../motion.css';

// 设计稿基准尺寸 1894 × 1007（Figma 实际画布）

interface HeroSectionProps {
  /** 「立即创建」按钮点击回调；不传时按钮仍可点击但无业务行为 */
  onCreateClick?: () => void;
}

export default function HeroSection({ onCreateClick }: HeroSectionProps = {}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [spotlight, setSpotlight] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const [mouse, setMouse] = useState<{ nx: number; ny: number }>({ nx: 0, ny: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const rect = sectionRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSpotlight({ x, y, visible: true });
    setMouse({ nx: x / rect.width - 0.5, ny: y / rect.height - 0.5 });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setSpotlight(s => ({ ...s, visible: false }));
    setMouse({ nx: 0, ny: 0 });
  }, []);

  // 视差大小顺序：01最大 > 03中 > 02最小
  // 01: ±32px  03: ±18px  02: ±6px
  const offset = (maxPx: number): React.CSSProperties => ({
    transform: `translate(${mouse.nx * maxPx}px, ${mouse.ny * maxPx}px)`,
    transition: 'transform 180ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  });

  return (
    <section
      ref={sectionRef}
      className="relative w-full"
      style={{ height: '100vh', minHeight: '600px', overflow: 'hidden', borderRadius: '0 0 48px 48px' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* ① 背景图 */}
      <img
        alt=""
        src={imgHeroBgNew}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
        draggable={false}
      />

      {/* ① 鼠标光晕层 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: spotlight.visible
            ? `radial-gradient(circle 380px at ${spotlight.x}px ${spotlight.y}px, rgba(255,255,255,0.22) 0%, transparent 70%)`
            : 'none',
          opacity: spotlight.visible ? 1 : 0,
          transition: 'opacity 300ms ease',
          zIndex: 15,
        }}
      />

      {/* ② 3D 装饰元素 */}

      {/* 首页元素01：机器人趴月球  左下 — 保持不动（产品要求：鼠标移动时不跟手） */}
      <div
        className="absolute lv-float-sm pointer-events-none"
        style={{ left: '0', bottom: '0', animationDelay: '0s', zIndex: 2 }}
      >
        <img
          alt=""
          src={imgHeroElement01}
          className="select-none block"
          style={{
            width: 'min(40.39vw, 71.68vh, 722px)',
            height: 'auto',
            objectFit: 'contain',
            objectPosition: 'left bottom',
          }}
          draggable={false}
        />
      </div>

      {/* 首页元素02：土星  左侧偏上 */}
      <div
        className="absolute lv-float pointer-events-none"
        style={{ left: '0', top: '31.43%', animationDelay: '1.5s', zIndex: 2 }}
      >
        <img
          alt=""
          src={imgHeroElement02}
          className="select-none block"
          style={{
            width: 'min(12.78vw, 24.04vh, 242px)',
            height: 'auto',
            objectFit: 'contain',
            ...offset(6),
          }}
          draggable={false}
        />
      </div>

      {/* 首页元素03：粉紫大球右下角 — 向内缩44px定位，padding留偏移缓冲 */}
      <div
        className="absolute lv-float-sm pointer-events-none"
        style={{ right: '-18px', bottom: '-18px', animationDelay: '0.8s', zIndex: 2 }}
      >
        <img
          alt=""
          src={imgHeroElement03}
          className="block select-none"
          style={{
            width: 'min(14.52vw, 21.11vh, 213px)',
            height: 'auto',
            ...offset(18),
          }}
          draggable={false}
        />
      </div>

      {/* ③ 内容层：居中展示，stagger reveal */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0 z-10 pointer-events-none">

        {/* Tagline 行 */}
        <div className="flex items-center gap-3 mb-6 lv-load-reveal lv-load-d100">
          <img
            alt=""
            src={imgHeroAvatars}
            className="select-none"
            style={{ height: '32px', objectFit: 'contain' }}
            draggable={false}
          />
          <p
            className="whitespace-nowrap"
            style={{
              fontFamily: "'PingFang SC', 'HarmonyOS Sans SC', sans-serif",
              fontWeight: 400,
              fontSize: '18px',
              lineHeight: '28px',
              color: 'rgba(0,0,0,0.9)',
            }}
          >
            云端托管 Hermes Agent，越聊越懂你的智能伙伴
          </p>
        </div>

        {/* 大标题 */}
        <p
          className="whitespace-nowrap lv-load-reveal lv-load-d200"
          style={{
            fontFamily: "'PingFang SC', 'HarmonyOS Sans SC', sans-serif",
            fontWeight: 600,
            fontSize: 'clamp(28px, 4vw, 64px)',
            lineHeight: 1.375,
            color: 'rgba(0,0,0,0.9)',
            marginBottom: '88px',
          }}
        >
          灵感随时发生，思考自由流动
        </p>

        {/* 按钮已移至独立 z-30 层 */}

      </div>

      {/* ④ 按钮层：独立 z-30，高于光晕层(z-15) */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0 z-[30] pointer-events-none">
        {/* invisible 占位，与内容层 tagline + 标题保持相同高度 */}
        <div className="invisible flex items-center gap-3 mb-6" style={{ height: '32px' }} />
        <div className="invisible whitespace-nowrap" style={{
          fontSize: 'clamp(28px, 4vw, 64px)',
          lineHeight: 1.375,
          marginBottom: '88px',
        }}>灵感随时发生，思考自由流动</div>
        <button
          type="button"
          onClick={onCreateClick}
          aria-label="立即创建"
          className="pointer-events-auto relative flex items-center justify-center cursor-pointer lv-load-reveal lv-load-d400 lv-btn-arrow lv-btn-cta border-0 outline-none"
          style={{
            minWidth: '200px',
            maxWidth: '314px',
            width: 'clamp(200px, 40vw, 314px)',
            height: '60px',
            padding: '0 clamp(16px, 4vw, 32px)',
            background: '#1A1A1A',
            borderRadius: '30px',
          }}
        >
          <span
            style={{
              fontFamily: "'PingFang SC', 'HarmonyOS Sans SC', sans-serif",
              fontWeight: 500,
              fontSize: 'clamp(14px, 2vw, 18px)',
              lineHeight: '24px',
              color: '#fff',
              whiteSpace: 'nowrap',
            }}
          >
            立即创建
          </span>
          <svg
            width="36"
            height="36"
            viewBox="0 0 36 36"
            fill="none"
            style={{
              position: 'absolute',
              right: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          >
            <path d="M18 0C27.9411 0 36 8.05888 36 18C36 27.9411 27.9411 36 18 36C8.05888 36 0 27.9411 0 18C0 8.05888 8.05888 0 18 0ZM16 11C15.4477 11 15 11.4477 15 12C15 12.5523 15.4477 13 16 13H21.5859L11.293 23.293C10.9024 23.6835 10.9024 24.3165 11.293 24.707C11.6835 25.0973 12.3166 25.0975 12.707 24.707L23 14.4141V20C23 20.5523 23.4477 21 24 21C24.5521 20.9998 25 20.5521 25 20V12C25 11.9203 24.9893 11.8429 24.9717 11.7686C24.9668 11.748 24.9622 11.7273 24.9561 11.707C24.9519 11.6934 24.9461 11.6803 24.9414 11.667C24.9149 11.5918 24.8801 11.5186 24.835 11.4502C24.7612 11.3383 24.6652 11.2423 24.5537 11.168C24.5148 11.142 24.474 11.1195 24.4326 11.0996C24.3871 11.0777 24.34 11.0579 24.291 11.043C24.252 11.0311 24.2118 11.0226 24.1719 11.0156C24.1161 11.006 24.0585 11 24 11H16Z" fill="white"/>
          </svg>
        </button>
      </div>
    </section>
  );
}
