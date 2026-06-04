import {
  svgPaths,
  imgCtaFooterCopyright,
} from '../assets';


function LightVelaLogo() {
  return (
    <div className="h-[26px] relative" style={{ width: 92.7 }}>
      <svg className="absolute block inset-0 size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 92.3494 21.2447">
        <g id="Group 2147208795">
          <path d={svgPaths.p28e50e80} fill="#1a1a1a" id="Union" />
          <path d={svgPaths.p8454d00} fill="#1a1a1a" id="Vector" />
          <path d={svgPaths.p17f91700} fill="#1a1a1a" id="Vector_2" />
          <path d={svgPaths.p3d1226f0} fill="#1a1a1a" id="Vector_3" />
          <path d={svgPaths.p15273d80} fill="#1a1a1a" id="Vector_4" />
          <path d={svgPaths.p20ef8100} fill="#1a1a1a" id="Vector_5" />
          <path d={svgPaths.p3f75c600} fill="#1a1a1a" id="Vector_6" />
          <path d={svgPaths.p1e695e00} fill="#1a1a1a" id="Vector_7" />
          <path d={svgPaths.p39110200} fill="#1a1a1a" id="Vector_8" />
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
        className="mx-auto flex items-center justify-between px-[140px]"
        style={{ height: 88, maxWidth: 1920 }}
      >
        {/* 左：LightVela SVG logo */}
        <LightVelaLogo />

        {/* 右：版权图片 */}
        <img
          alt="© 2026 LightVela 版权所有，由腾讯轻量云团队出品"
          src={imgCtaFooterCopyright}
          style={{ width: 461, height: 22, fontSize: 14, lineHeight: '21px', color: '#252525' }}
        />
      </div>
    </footer>
  );
}
