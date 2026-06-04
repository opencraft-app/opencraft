import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  svgPaths,
  imgImage4, imgImage4588,
  imgCtaDeco, imgCtaLogo1, imgCtaLogo2,
} from '../assets';
import '../motion.css';
import { useScrollReveal } from '../useScrollReveal';


function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 14L14 2" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 2H14V10" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function CreateButton() {
  return (
    <button className="flex items-center bg-[#1a1a1a] text-white rounded-full pl-8 pr-3 h-[60px] w-[314px] cursor-pointer shrink-0 lv-btn-arrow">
      <span className="flex-1 font-['PingFang_SC:Medium',sans-serif] text-[16px] leading-[24px] font-medium text-center">立即创建</span>
      <span className="flex items-center justify-center bg-white rounded-full w-10 h-10 shrink-0">
        <ArrowIcon />
      </span>
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


export default function CtaSection() {
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
            <CreateButton />
          </div>
        </div>
      </div>
    </section>
  );
}
