import { imgHeroBgNew, imgHeroElement01, imgHeroElement02, imgHeroElement03, imgHeroAvatars } from '../assets';
import '../motion.css';

// 设计稿基准尺寸 2560 × 1081
const W = 2560;
const H = 1081;

function px(n: number) { return `${(n / W) * 100}%`; }
function py(n: number) { return `${(n / H) * 100}%`; }

export default function HeroSection() {
  return (
    <section
      className="relative w-full overflow-hidden"
      style={{ height: '100vh', minHeight: '600px' }}
    >
      {/* ① 背景图 */}
      <img
        alt=""
        src={imgHeroBgNew}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
        draggable={false}
      />

      {/* ② 3D 装饰元素 */}

      {/* 首页元素01：机器人趴月球  左下 */}
      <img
        alt=""
        src={imgHeroElement01}
        className="absolute pointer-events-none select-none lv-float-sm"
        style={{
          left: px(0),
          top: py(689),
          width: px(765),
          height: py(392),
          objectFit: 'cover',
          objectPosition: 'center top',
          animationDelay: '0s',
        }}
        draggable={false}
      />

      {/* 首页元素02：土星  左侧偏上 */}
      <img
        alt=""
        src={imgHeroElement02}
        className="absolute pointer-events-none select-none lv-float"
        style={{
          left: px(130),
          top: py(220),
          width: px(242),
          height: py(169),
          objectFit: 'contain',
          animationDelay: '1.5s',
        }}
        draggable={false}
      />

      {/* 首页元素03：粉紫大球右下角 */}
      <div
        className="absolute overflow-hidden pointer-events-none lv-float-sm"
        style={{ right: 0, bottom: 0, width: px(560), height: py(200), animationDelay: '0.8s' }}
      >
        <img
          alt=""
          src={imgHeroElement03}
          className="absolute bottom-0 right-0"
          style={{ width: px(560) }}
          draggable={false}
        />
      </div>

      {/* ③ 内容层：居中展示，stagger reveal */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0 z-10 pointer-events-none">

        {/* Tagline 行 */}
        <div className="flex items-center gap-3 mb-6 lv-reveal lv-revealed lv-delay-100">
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
          className="whitespace-nowrap mb-10 lv-reveal lv-revealed lv-delay-200"
          style={{
            fontFamily: "'PingFang SC', 'HarmonyOS Sans SC', sans-serif",
            fontWeight: 600,
            fontSize: 'clamp(28px, 4vw, 64px)',
            lineHeight: 1.375,
            color: 'rgba(0,0,0,0.9)',
          }}
        >
          灵感随时发生，思考自由流动
        </p>

        {/* 按钮 */}
        <div
          className="pointer-events-auto flex items-center justify-center gap-2 cursor-pointer lv-reveal lv-revealed lv-delay-400 lv-btn-arrow"
          style={{
            width: '314px',
            height: '60px',
            padding: '0 32px',
            background: '#1A1A1A',
            borderRadius: '30px',
          }}
        >
          <span
            style={{
              fontFamily: "'PingFang SC', 'HarmonyOS Sans SC', sans-serif",
              fontWeight: 500,
              fontSize: '18px',
              lineHeight: '24px',
              color: '#fff',
              whiteSpace: 'nowrap',
            }}
          >
            立即创建
          </span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 14L14 2" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 2H14V10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

      </div>
    </section>
  );
}
