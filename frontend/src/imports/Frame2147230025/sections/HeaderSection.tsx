import {
  svgPaths,
  imgImage, imgImage614591645, imgImage614591647, imgImage614591648,
  imgImage4597, imgImage8, imgImage9, imgImage10, imgImage614591630,
  imgImage614591599, imgImage11, imgImage12, imgImage614591617,
  imgImage614591621, imgImage614591622, imgImage614591623, imgImage614591620,
  imgImage614591618, imgImage614591619, imgEllipse1115024, imgEllipse1115029,
  imgVector7806, imgVector7807, imgVector7808,
  imgImage4120, imgImage4119, imgImage4118, imgImage4117, imgImage4103,
  imgImage4042, imgImage4102, imgFrame2147229949, imgImage4316,
  imgImage4112, imgImage4110, imgImage4111, imgImage4113, imgImage4114,
  imgImage4115, imgImage4116, imgImage4121, imgImage4122, imgImage4123,
  imgImage4124, imgImage4125, imgImage4126, imgImage4127, imgImage4128,
  imgImage4129, imgImage4130, imgRectangle1329139236, imgImage4131,
  imgImage3, imgEllipse111556, imgEllipse111550, imgImage4,
  imgRoundedRectangle, imgRoundedRectangle1, imgEllipse111566,
  imgVector919, imgImage4588, imgImage614591606,
  imgImage614591644, imgImage614591646, imgImage1, imgImage2
} from '../assets';


function Group6() {
  return (
    <div className="absolute h-[21.245px] left-0 top-[4.52px] w-[92.349px]">
      <svg className="absolute block inset-0 size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 92.3494 21.2447">
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


function Frame9() {
  return (
    <div className="h-[26px] relative shrink-0 w-[92.696px]">
      <Group6 />
    </div>
  );
}


export function Frame4() {
  return (
    <div className="content-stretch flex items-center relative shrink-0">
      <Frame9 />
    </div>
  );
}


function Component5() {
  return (
    <div className="backdrop-blur-[8.05px] bg-[rgba(245,245,245,0.5)] content-stretch flex gap-[4px] items-center px-[24px] py-[7px] relative rounded-[100px] shrink-0" data-name="Component 53">
      <div aria-hidden className="absolute border border-[#e6e9ef] border-solid inset-0 pointer-events-none rounded-[100px]" />
      <p className="[word-break:break-word] font-['PingFang_SC:Medium',sans-serif] leading-[22px] not-italic relative shrink-0 text-[14px] text-[rgba(0,0,0,0.9)] text-center whitespace-nowrap">登录</p>
    </div>
  );
}


function Component6() {
  return (
    <div className="bg-[#161617] content-stretch flex gap-[8px] items-center justify-center px-[24px] py-[7px] relative rounded-[38px] shrink-0" data-name="Component 53">
      <p className="[word-break:break-word] font-['PingFang_SC:Medium',sans-serif] leading-[22px] not-italic relative shrink-0 text-[14px] text-center text-white whitespace-nowrap">立即创建</p>
    </div>
  );
}


function Frame5() {
  return (
    <div className="content-stretch flex gap-[12px] items-center relative shrink-0">
      <Component5 />
      <Component6 />
    </div>
  );
}


function Frame14() {
  return (
    <div className="-translate-x-1/2 -translate-y-1/2 [word-break:break-word] absolute content-stretch flex font-['PingFang_SC:Medium',sans-serif] gap-[32px] h-[32px] items-center leading-[0] left-[calc(50%+0.07px)] not-italic text-[14px] text-[rgba(0,0,0,0.7)] top-[calc(50%-1px)] whitespace-nowrap">
      <div className="flex flex-col justify-center relative shrink-0">
        <p className="leading-[22px]">概览</p>
      </div>
      <div className="flex flex-col justify-center relative shrink-0">
        <p className="leading-[22px]">更新日志</p>
      </div>
      <div className="flex flex-col justify-center relative shrink-0">
        <p className="leading-[22px]">产品文档</p>
      </div>
      <div className="flex flex-col justify-center relative shrink-0">
        <p className="leading-[22px]">养虾博客</p>
      </div>
    </div>
  );
}


export default function HeaderSection() {
  return (
    <header className="w-full absolute top-0 left-0 z-20">
      <div className="mx-auto flex items-center justify-between px-16 py-3" style={{ width: 'min(1440px, calc(100vw - 128px))' }}>
        {/* Logo */}
        <Frame4 />
        {/* 中间导航：宽度不足时隐藏 */}
        <nav className="hidden lg:flex gap-8 text-[14px] font-['PingFang_SC:Medium',sans-serif] text-[rgba(0,0,0,0.7)]">
          <span>概览</span>
          <span>更新日志</span>
          <span>产品文档</span>
          <span>养虾博客</span>
        </nav>
        {/* 右侧按钮 */}
        <Frame5 />
      </div>
    </header>
  );
}
