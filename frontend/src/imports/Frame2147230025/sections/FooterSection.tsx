// @ts-nocheck — Figma auto-generated; suppress strict TS lints (noUnusedLocals etc.)
import { svgPaths } from '../assets';


function LightVelaLogo() {
  return (
    <div className="h-[26px] relative" style={{ width: 92.7 }}>
      <svg
        className="absolute block inset-0 size-full"
        fill="none"
        preserveAspectRatio="none"
        viewBox="0 0 92.3494 21.2447"
        role="img"
        aria-label="LightVela"
      >
        <title>LightVela</title>
        <g id="Group 2147208795">
          <path d={svgPaths.p28e50e80} fill="var(--fill-0, black)" id="Union" />
          <path d={svgPaths.p8454d00} fill="var(--fill-0, black)" id="Vector" />
          <path d={svgPaths.p17f91700} fill="var(--fill-0, black)" id="Vector_2" />
          <path d={svgPaths.p3d1226f0} fill="var(--fill-0, black)" id="Vector_3" />
          <path d={svgPaths.p15273d80} fill="var(--fill-0, black)" id="Vector_4" />
          <path d={svgPaths.p20ef8100} fill="var(--fill-0, black)" id="Vector_5" />
          <path d={svgPaths.p3f75c600} fill="var(--fill-0, black)" id="Vector_6" />
          <path d={svgPaths.p1e695e00} fill="var(--fill-0, black)" id="Vector_7" />
          <path d={svgPaths.p39110200} fill="var(--fill-0, black)" id="Vector_8" />
        </g>
      </svg>
    </div>
  );
}


export default function FooterSection() {
  return (
    <footer
      className="w-full bg-white mx-auto"
      style={{
        borderTop: '1px solid #e2e8f0',
        borderRadius: '20px 20px 0 0',
      }}
    >
      <div
        className="mx-auto flex items-center justify-between px-16"
        style={{ height: 88, maxWidth: 1920 }}
      >
        {/* 左：LightVela SVG logo */}
        <LightVelaLogo />

        {/* 右：版权文字 */}
        <p
          className="font-['Noto_Sans_SC:Regular',sans-serif] font-normal leading-[22px] text-[14px] text-[rgba(51,65,85,0.7)] whitespace-nowrap"
        >
          © 2026 LightVela 版权所有，由腾讯轻量云团队出品
        </p>
      </div>
    </footer>
  );
}
