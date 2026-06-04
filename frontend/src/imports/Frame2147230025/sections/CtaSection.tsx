import React from 'react';
import {
  svgPaths,
  imgImage4, imgImage4588,
  imgCtaDeco, imgCtaLogo1, imgCtaLogo2,
  imgImage614591606,
} from '../assets';
import '../motion.css';
import { useScrollReveal } from '../useScrollReveal';


function ArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1.5 10.5L10.5 1.5" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 1.5H10.5V7.5" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function CreateButton() {
  return (
    <button className="flex items-center gap-2 bg-[#1a1a1a] text-white rounded-full pl-6 pr-2 py-2 h-12 cursor-pointer shrink-0 lv-btn-arrow lv-btn-shadow">
      <span className="font-['PingFang_SC:Medium',sans-serif] text-[13.5px] leading-[18px] font-medium">立即创建</span>
      <span className="flex items-center justify-center bg-white rounded-full size-[27px] shrink-0">
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


function MascotGroup() {
  return (
    <div className="absolute pointer-events-none lv-float" style={{ right: -100, top: -20, width: 79, height: 88 }}>
      <div className="flex items-center justify-center w-full h-full">
        <div style={{ transform: 'rotate(12.96deg)' }}>
          <div className="relative overflow-hidden" style={{ width: 64, height: 75 }}>
            <img
              alt=""
              src={imgImage614591606}
              className="absolute max-w-none pointer-events-none"
              style={{ width: '684.34%', height: '388.21%', left: 0, top: '-137.51%' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


function TitleBlock() {
  return (
    <div>
      {/* 开启旅程 — 带吉祥物装饰 */}
      <div className="relative inline-block">
        <h2 className="font-['HYRuiYiSong:45J',sans-serif] text-[#1a1a1a] whitespace-nowrap" style={{ fontSize: '48px', lineHeight: '64px', width: '256px', height: '64px' }}>
          开启旅程
        </h2>
        <Ellipse />
        <MascotGroup />
      </div>
      {/* 准备好开启 探索之旅 了吗？ */}
      <div className="font-['HYRuiYiSong:45J',sans-serif] text-[#1a1a1a] whitespace-nowrap" style={{ fontSize: '48px', lineHeight: '64px', width: '768px', height: '64px' }}>
        准备好开启
        <span className="text-transparent bg-clip-text" style={{ backgroundImage: 'linear-gradient(90deg, #3503ff 0%, #D587FF 49.519%, #FFCA80 100%)' }}>
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
      <img alt="Hermes Agent" src="/hermes-agent-logo.png" className="h-10 w-auto" />
      <img alt="OpenClaw" src="/openclaw-logo.png" className="h-10 w-auto" />
    </div>
  );
}


export default function CtaSection() {
  const ref = useScrollReveal();
  return (
    <section className="w-full bg-white relative overflow-hidden" ref={ref as React.RefObject<HTMLElement>}>
      {/* 背景装饰光晕 */}
      <img
        src={imgCtaDeco}
        alt=""
        className="absolute pointer-events-none select-none lv-breathe"
        style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 800, height: 800, opacity: 0.6 }}
      />

      {/* 内容区 */}
      <div
        className="mx-auto relative"
        style={{ width: 'min(1440px, calc(100vw - 128px))', paddingTop: 80, paddingBottom: 80 }}
      >
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-12">
          {/* 左侧 .journey-copy */}
          <div className="flex flex-col lv-reveal">
            <TitleBlock />
            {/* 副文案 */}
            <p className="mt-6 text-[14px] font-['PingFang_SC:Regular',sans-serif] leading-6 lv-reveal lv-delay-200" style={{ height: '44px', paddingTop: '12px', paddingBottom: '12px', color: '#00000080' }}>
              隐私政策 · 服务条款 · 加入用户交流群
            </p>
            <LogoGroup />
          </div>

          {/* 右侧 .journey-action */}
          <div className="flex flex-col items-start lg:items-end gap-6 shrink-0 lv-reveal lv-delay-300">
            <p className="text-[14px] font-['PingFang_SC:Regular',sans-serif] text-[#1a1a1a] leading-6 lg:text-right whitespace-nowrap" style={{ width: '246px' }}>
              你的 AI 在云端等你，随时随地伴你同行
            </p>
            <CreateButton />
          </div>
        </div>
      </div>
    </section>
  );
}
