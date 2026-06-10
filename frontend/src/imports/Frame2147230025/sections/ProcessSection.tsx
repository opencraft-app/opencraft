import React from 'react';
import '../motion.css';
import { useScrollReveal } from '../useScrollReveal';
import {
  svgPaths, imgImage614591617,
  imgImage614591621, imgImage614591622, imgImage614591623, imgImage614591620,
  imgImage614591618, imgImage614591619
} from '../assets';

function StepBadge({ label, width = 90 }: { label: string; width?: number }) {
  return (
    <div
      className="inline-flex items-center justify-center rounded-[6px] relative"
      style={{
        width,
        height: 32,
        background: 'linear-gradient(130.4deg, rgba(251,191,255,0.2) 0%, rgba(28,73,255,0.2) 100%)',
        padding: '1px' }}
    >
      {/* 渐变边框：三段渐变 白→粉→蓝 */}
      <div
        className="absolute inset-0 rounded-[6px] pointer-events-none"
        style={{
          background: 'linear-gradient(124.1deg, #ffffff 15%, #fbbfff 26%, #1c49ff 100%)',
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'destination-out',
          maskComposite: 'exclude',
          padding: '1px',
          opacity: 0.4 }}
      />
      <span
        className="font-['Menlo:Regular',sans-serif] leading-6 relative"
        style={{
          fontSize: 16,
          background: 'linear-gradient(90deg, #f0efff 19.828%, #9ca8ff 151.72%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent' }}
      >{label}</span>
    </div>
  );
}

// 设计稿基准 1894 × 824
const W = 1894;
const H = 824;
const p = (n: number, base = W) => `${(n / base) * 100}%`;

export default function ProcessSection() {
  const ref = useScrollReveal();
  return (
    <section className="w-full" ref={ref as React.RefObject<HTMLElement>}>
      {/* ── 桌面端：固定高度 824px，内容居中 ── */}
      <div
        className="relative w-full overflow-hidden hidden lg:block lv-reveal"
        style={{
          height: '824px',
          backgroundImage: "linear-gradient(178.564deg, rgb(16,14,7) 2.7595%, rgb(21,18,18) 56.147%, rgb(63,52,118) 105.78%)",
          borderRadius: 48 }}
      >
        {/* 背景光晕 SVG */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute" style={{ left: p(68), top: p(140, H), width: '108%', height: '133%' }}>
            <div style={{ transform: 'rotate(15deg) skewX(3.58deg)', width: '100%', height: '100%' }}>
              <svg className="w-full h-full" fill="none" viewBox="0 0 2242.99 839.107" preserveAspectRatio="none">
                <g filter="url(#filter0_f_proc)" opacity="0.4">
                  <path d={svgPaths.p39383350} fill="url(#paint0_proc)" />
                </g>
                <defs>
                  <filter id="filter0_f_proc" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" x="0" y="0" width="2242.99" height="839.107">
                    <feFlood floodOpacity="0" result="BackgroundImageFix" />
                    <feBlend in="SourceGraphic" in2="BackgroundImageFix" mode="normal" result="shape" />
                    <feGaussianBlur stdDeviation="60" result="effect1_foregroundBlur_proc" />
                  </filter>
                  <linearGradient id="paint0_proc" gradientUnits="userSpaceOnUse" x1="181.231" x2="2058.73" y1="764.862" y2="234.963">
                    <stop stopColor="#FFDE39" stopOpacity="0.3" />
                    <stop offset="0.303421" stopColor="#FEE0D4" stopOpacity="0.9" />
                    <stop offset="0.516189" stopColor="#AA7FFF" stopOpacity="0.5" />
                    <stop offset="0.698469" stopColor="#AA7FFF" stopOpacity="0.5" />
                    <stop offset="1" stopColor="#264BFF" stopOpacity="0.5" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
          </div>
        </div>
        {/* 轨道圆环 */}
        <svg
          className="absolute pointer-events-none overflow-visible"
          style={{ left: p(1074), top: p(182, H), width: p(560), height: p(560, H) }}
          viewBox="0 0 560 560"
          fill="none"
        >
          <defs>
            <linearGradient id="orbit-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="white" stopOpacity="0.08" />
              <stop offset="100%" stopColor="white" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          <circle cx="280" cy="280" r="279" stroke="url(#orbit-grad)" strokeWidth="1" strokeDasharray="5 5" />
          <circle cx="280" cy="280" r="156" stroke="url(#orbit-grad)" strokeWidth="1" strokeDasharray="5 5" />
        </svg>
        {/* 右侧星球：轻微漂浮 */}
        <img alt="" src={imgImage614591619} className="absolute mix-blend-plus-lighter pointer-events-none lv-float" style={{ left: p(1559), top: p(82, H), width: p(144), objectFit: 'contain', animationDelay: '0s' }} />
        <img alt="" src={imgImage614591618} className="absolute mix-blend-plus-lighter pointer-events-none rotate-90 lv-float-sm" style={{ left: p(1517), top: p(226, H), width: p(51), objectFit: 'contain', animationDelay: '1s' }} />
        <img alt="" src={imgImage614591620} className="absolute mix-blend-plus-lighter pointer-events-none lv-float-sm" style={{ left: p(1422), top: p(310, H), width: p(89), objectFit: 'contain', animationDelay: '2s' }} />
        <img alt="" src={imgImage614591617} className="absolute mix-blend-plus-lighter pointer-events-none lv-float" style={{ left: p(1298), top: p(406, H), width: p(113), objectFit: 'contain', animationDelay: '0.5s' }} />
        <img alt="" src={imgImage614591621} className="absolute mix-blend-plus-lighter pointer-events-none lv-float-sm" style={{ left: p(1216), top: p(543, H), width: p(56), objectFit: 'contain', animationDelay: '1.5s' }} />
        <img alt="" src={imgImage614591622} className="absolute mix-blend-plus-lighter pointer-events-none lv-float" style={{ left: p(1128), top: p(606, H), width: p(99), objectFit: 'contain', animationDelay: '2.5s' }} />
        <img alt="" src={imgImage614591623} className="absolute mix-blend-plus-lighter pointer-events-none lv-float-sm" style={{ left: p(1061), top: p(741, H), width: p(22), objectFit: 'contain', animationDelay: '3s' }} />
        {/* process-title：标题居中 */}
        <div className="absolute left-0 right-0 flex flex-col items-center text-center gap-4 lv-reveal" style={{ top: '60px', zIndex: 10 }}>
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            {/* 左上角装饰 */}
            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" fill="none"
              style={{ position: 'absolute', left: '-16px', top: '-2px' }}>
              <rect x="4" width="4" height="4" fill="white"/>
              <rect width="4" height="8" fill="white"/>
            </svg>
            <h2
              className="lw-font-hyruiyisong text-white leading-[48px] whitespace-nowrap"
              style={{
                fontSize: '32px',
                WebkitTextStrokeWidth: '0.6px',
                WebkitTextStrokeColor: 'rgba(255, 255, 255, 0.9)' }}
            >探索 LightVela 流程</h2>
            {/* 右下角装饰 */}
            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" fill="none"
              style={{ position: 'absolute', right: '-16px', bottom: '-2px', transform: 'rotate(180deg)' }}>
              <rect x="4" width="4" height="4" fill="white"/>
              <rect width="4" height="8" fill="white"/>
            </svg>
          </div>
          <p className="font-['PingFang_SC:Regular',sans-serif] text-[rgba(255,255,255,0.5)] leading-6 whitespace-nowrap" style={{ fontSize: '16px' }}>我们把 Hermes Agent 搬上云端，让你无需折腾部署，随时唤醒，对话数据永远只属于你。</p>
        </div>
        {/* process-grid > steps：左侧步骤列表（绝对定位，精确对齐 Figma 坐标） */}
        {/* Step 1: badge y=233.5, title y=289.5, desc y=333.5 */}
        <article className="absolute lv-reveal lv-delay-200" style={{ left: p(280), top: p(233.5, H), zIndex: 10 }}>
          <StepBadge label="Step 1" width={90} />
          <h3 className="lw-font-hyruiyisong text-white" style={{ marginTop: '24px', fontSize: 24, lineHeight: '32px', whiteSpace: 'nowrap', width: 256 }}>点击「立即创建」</h3>
          <p className="font-['PingFang_SC:Regular',sans-serif]" style={{ marginTop: '12px', fontSize: 14, lineHeight: '24px', color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>选择订阅，点一下按钮，就这样</p>
        </article>
        {/* Step 2: badge y=432.5, title y=489, desc y=532.5 */}
        <article className="absolute lv-reveal lv-delay-400" style={{ left: p(280), top: p(432.5, H), zIndex: 10 }}>
          <StepBadge label="Step 2" width={87} />
          <h3 className="lw-font-hyruiyisong text-white" style={{ marginTop: '24px', fontSize: 24, lineHeight: '32px', whiteSpace: 'nowrap', width: 256 }}>系统自动帮你创建</h3>
          <p className="font-['PingFang_SC:Regular',sans-serif]" style={{ marginTop: '12px', fontSize: 14, lineHeight: '24px', color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>喝口水的功夫，云端 Agent 即创建完成。</p>
        </article>
        {/* Step 3: badge y=611.5, title y=667.5, desc y=713.5 */}
        <article className="absolute lv-reveal lv-delay-600" style={{ left: p(280), top: p(611.5, H), zIndex: 10 }}>
          <StepBadge label="Step 3" width={90} />
          <h3 className="lw-font-hyruiyisong text-white" style={{ marginTop: '24px', fontSize: 24, lineHeight: '32px', whiteSpace: 'nowrap', width: 256 }}>和智能伙伴开始对话</h3>
          <p className="font-['PingFang_SC:Regular',sans-serif]" style={{ marginTop: '12px', fontSize: 14, lineHeight: '24px', color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>创建完成后，绑定聊天通道，即刻开始探索之旅</p>
        </article>
        {/* 渐变虚线（Figma Vector7806/7807/7808）—— x=406.5 起，y=249/448/627 */}
        <div className="absolute" style={{ left: p(406.5), top: p(249, H), width: p(771.5) }}>
          <svg width="100%" height="1" viewBox="0 0 771.5 1" fill="none" preserveAspectRatio="none">
            <path d="M771.5 0.5L0 0.5" stroke="url(#dash1)" strokeWidth="1" strokeDasharray="5.45 5.45" />
            <defs><linearGradient id="dash1" x1="0" y1="1" x2="385.75" y2="0.999929" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF" stopOpacity="0" /><stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.13" /><stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></linearGradient></defs>
          </svg>
        </div>
        <div className="absolute" style={{ left: p(406.5), top: p(448, H), width: p(672) }}>
          <svg width="100%" height="1" viewBox="0 0 672 1" fill="none" preserveAspectRatio="none">
            <path d="M672 0.5L0 0.5" stroke="url(#dash2)" strokeWidth="1" strokeDasharray="5.45 5.45" />
            <defs><linearGradient id="dash2" x1="0" y1="1" x2="336" y2="0.999929" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF" stopOpacity="0" /><stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.13" /><stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></linearGradient></defs>
          </svg>
        </div>
        <div className="absolute" style={{ left: p(406.5), top: p(627, H), width: p(733) }}>
          <svg width="100%" height="1" viewBox="0 0 733 1" fill="none" preserveAspectRatio="none">
            <path d="M733 0.5L0 0.5" stroke="url(#dash3)" strokeWidth="1" strokeDasharray="5.45 5.45" />
            <defs><linearGradient id="dash3" x1="0" y1="1" x2="366.5" y2="0.999929" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF" stopOpacity="0" /><stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.13" /><stop offset="1" stopColor="#FFFFFF" stopOpacity="0" /></linearGradient></defs>
          </svg>
        </div>

        {/* 左侧竖线 + 左上/左下十字（Figma Vector7854 + Group2147209083） */}
        {/* 左上十字：x=231.5, y=17.5，16×16 */}
        <svg className="absolute pointer-events-none" style={{ left: p(231.5), top: p(17.5, H), width: '16px', height: '16px' }} viewBox="0 0 16 16" fill="none">
          <line x1="8" y1="0" x2="8" y2="16" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          <line x1="0" y1="8" x2="16" y2="8" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
        </svg>
        {/* 左竖线：x=239, y=51.5, h=720 */}
        <div className="absolute pointer-events-none" style={{ left: p(239), top: p(51.5, H), width: 1, height: p(720, H) }}>
          <svg width="1" height="100%" fill="none">
            <line x1="0.5" y1="0" x2="0.5" y2="100%" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          </svg>
        </div>
        {/* 左下十字：x=231.5, y=789.5，16×16 */}
        <svg className="absolute pointer-events-none" style={{ left: p(231.5), top: p(789.5, H), width: '16px', height: '16px' }} viewBox="0 0 16 16" fill="none">
          <line x1="8" y1="0" x2="8" y2="16" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          <line x1="0" y1="8" x2="16" y2="8" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
        </svg>

        {/* 右侧竖线 + 右上/右下十字（Figma Vector7813 + Group2147209083-top + Group2147209084-bottom） */}
        {/* 右竖线：x=1680, y=52, h=720 */}
        <div className="absolute pointer-events-none" style={{ left: p(1680), top: p(52, H), width: 1, height: p(720, H) }}>
          <svg width="1" height="100%" fill="none">
            <line x1="0.5" y1="0" x2="0.5" y2="100%" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          </svg>
        </div>
        {/* 右上十字：x=1672, y=18，16×16 */}
        <svg className="absolute pointer-events-none" style={{ left: p(1672), top: p(18, H), width: '16px', height: '16px' }} viewBox="0 0 16 16" fill="none">
          <line x1="8" y1="0" x2="8" y2="16" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          <line x1="0" y1="8" x2="16" y2="8" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
        </svg>
        {/* 右下十字：x=1672, y=790，16×16 */}
        <svg className="absolute pointer-events-none" style={{ left: p(1672), top: p(790, H), width: '16px', height: '16px' }} viewBox="0 0 16 16" fill="none">
          <line x1="8" y1="0" x2="8" y2="16" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
          <line x1="0" y1="8" x2="16" y2="8" stroke="#E2E8F0" strokeOpacity="0.13" strokeWidth="1" />
        </svg>
      </div>

      {/* ── 移动端：上下流式布局（参考 HTML process-grid 结构）── */}
      <div
        className="lg:hidden w-full overflow-hidden rounded-[48px] px-8 pt-12 pb-10 flex flex-col gap-10"
        style={{ backgroundImage: "linear-gradient(178.564deg, rgb(16,14,7) 2.7595%, rgb(21,18,18) 56.147%, rgb(63,52,118) 105.78%)" }}
      >
        {/* 标题 */}
        <div className="text-center flex flex-col gap-4 lv-reveal">
          <h2 className="lw-font-hyruiyisong text-white text-[24px] leading-[36px]">探索 LightVela 流程</h2>
          <p className="font-['PingFang_SC:Regular',sans-serif] text-[rgba(255,255,255,0.5)] text-[14px] leading-6">我们把 Hermes Agent 搬上云端，让你无需折腾部署，随时唤醒，对话数据永远只属于你。</p>
        </div>
        {/* 步骤 */}
        <div className="flex flex-col gap-8 lv-reveal lv-delay-200">
          {[
            { step: 'Step 1', title: '点击「立即创建」', desc: '选择订阅，点一下按钮，就这样' },
            { step: 'Step 2', title: '系统自动帮你创建', desc: '喝口水的功夫，云端 Agent 即创建完成。' },
            { step: 'Step 3', title: '和智能伙伴开始对话', desc: '创建完成后，绑定聊天通道，即刻开始探索之旅' },
          ].map(({ step, title, desc }) => (
            <article key={step} className="flex flex-col gap-2">
              <StepBadge label={step} />
              <p className="lw-font-hyruiyisong text-white text-[20px] leading-[30px] mt-1">{title}</p>
              <p className="font-['PingFang_SC:Regular',sans-serif] text-[rgba(255,255,255,0.7)] text-[13px] leading-6">{desc}</p>
            </article>
          ))}
        </div>
        {/* 星球图（移动端垂直堆叠展示） */}
        <div className="flex justify-center gap-4 flex-wrap opacity-70" aria-hidden="true">
          <img alt="" src={imgImage614591622} className="mix-blend-plus-lighter w-16 h-16 object-contain" />
          <img alt="" src={imgImage614591617} className="mix-blend-plus-lighter w-16 h-16 object-contain" />
          <img alt="" src={imgImage614591619} className="mix-blend-plus-lighter w-16 h-16 object-contain" />
        </div>
      </div>
    </section>
  );
}
