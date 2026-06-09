// @ts-nocheck — Figma auto-generated; suppress strict TS lints (noUnusedLocals etc.)
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  svgPaths,
  imgImage4, imgImage4588,
  imgCtaDeco, imgCtaLogo1, imgCtaLogo2,
} from '../assets';
import '../motion.css';
import { useScrollReveal } from '../useScrollReveal';





function CreateButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="立即创建"
      className="relative flex items-center justify-center cursor-pointer shrink-0 lv-btn-arrow lv-btn-cta border-0 outline-none"
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
  );
}


function Ellipse() {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        width: 64,
        height: 36,
        right: -80,
        top: 8,
        transform: 'rotate(-35.83deg)',
        borderRadius: '50%',
        background: 'linear-gradient(90deg, #3503FF 0%, #D587FF 50%, #FFCA80 100%)',
        opacity: 0.9,
      }}
    />
  );
}


interface MascotGroupProps {
  offsetX: number;
  offsetY: number;
}

function MascotGroup({ offsetX, offsetY }: MascotGroupProps) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{ right: -70, top: -50, width: 126, height: 118 }}
    >
      <div className="flex items-center justify-center w-full h-full">
        <div
          style={{
            transform: `rotate(12.96deg) translate(${offsetX}px, ${offsetY}px)`,
            transition: 'transform 200ms ease-out',
          }}
        >
          <img
            alt=""
            src="/Slice 1.png"
            className="pointer-events-none"
            style={{ width: 126, height: 118 }}
          />
        </div>
      </div>
    </div>
  );
}


function TitleBlock({ offsetX, offsetY }: { offsetX: number; offsetY: number }) {
  return (
    <div>
      {/* 开启旅程 — 带吉祥物装饰 */}
      <div className="relative inline-block">
        <h2 className="text-[#1a1a1a] whitespace-nowrap" style={{ fontFamily: "'HYRuiYiSong:45J', sans-serif", fontSize: '48px', lineHeight: '64px', width: '256px', height: '64px' }}>
          开启旅程
        </h2>
        <MascotGroup offsetX={offsetX} offsetY={offsetY} />
      </div>
      {/* 准备好开启 探索之旅 了吗？ */}
      <div className="text-[#1a1a1a] whitespace-nowrap" style={{ fontFamily: "'HYRuiYiSong:45J', sans-serif", fontSize: '48px', lineHeight: '64px', width: '768px', height: '64px' }}>
        准备好开启
        <span className="text-transparent bg-clip-text" style={{ backgroundImage: 'linear-gradient(90deg, rgb(53, 3, 255) 0%, rgb(213, 135, 255) 49.519%, rgb(255, 202, 128) 100%)' }}>
          探索之旅
        </span>
        了吗？
      </div>
    </div>
  );
}


function LogoGroup() {
  return (
    <div className="mt-8 flex items-center gap-8">
      <img alt="Hermes Agent" src="/hermes_logo.png" className="h-6 w-auto" />
      <img alt="OpenClaw" src="/lightclaw-logo.png" className="h-6 w-auto" />
    </div>
  );
}


interface CtaSectionProps {
  onCreateClick?: () => void;
}

export default function CtaSection({ onCreateClick }: CtaSectionProps = {}) {
  const ref = useScrollReveal();
  const sectionRef = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      // 计算相对于 section 中心的位置
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const x = (e.clientX - centerX) * 0.015;
      const y = (e.clientY - centerY) * 0.015;
      setOffset({ x, y });
    };

    const handleMouseLeave = () => {
      setOffset({ x: 0, y: 0 });
    };

    const section = sectionRef.current;
    if (section) {
      section.addEventListener('mousemove', handleMouseMove);
      section.addEventListener('mouseleave', handleMouseLeave);
    }

    return () => {
      if (section) {
        section.removeEventListener('mousemove', handleMouseMove);
        section.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, []);

  return (
    <section ref={sectionRef} className="w-full bg-white relative overflow-hidden">
      {/* 背景装饰光晕 */}
      <img
        src={imgCtaDeco}
        alt=""
        className="absolute pointer-events-none select-none lv-breathe"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 800, height: 800, opacity: 0.6 }}
      />

      {/* 内容区 */}
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        className="mx-auto relative"
        style={{ width: 'min(1440px, calc(100vw - 128px))', paddingTop: 80, paddingBottom: 80 }}
      >
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-12">
          {/* 左侧 .journey-copy */}
          <div className="flex flex-col lv-reveal">
            <TitleBlock offsetX={offset.x} offsetY={offset.y} />
            {/* 副文案 */}
            <p className="mt-6 text-[14px] font-['PingFang_SC:Regular',sans-serif] leading-6 lv-reveal lv-delay-200" style={{ height: '44px', paddingTop: '12px', paddingBottom: '12px', color: '#00000080' }}>
              隐私政策 · 服务条款 · 加入用户交流群
            </p>
            <LogoGroup />
          </div>

          {/* 右侧 .journey-action */}
          <div className="flex flex-col items-start lg:items-end gap-6 shrink-0 lv-reveal lv-delay-300">
            <p className="text-[14px] font-['PingFang_SC:Regular',sans-serif] text-[#1a1a1a] leading-6 lg:text-center whitespace-nowrap" style={{ width: '246px' }}>
              你的 AI 在云端等你，随时随地伴你同行
            </p>
            <CreateButton onClick={onCreateClick} />
          </div>
        </div>
      </div>
    </section>
  );
}
