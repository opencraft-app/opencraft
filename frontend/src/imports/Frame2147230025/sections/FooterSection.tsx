import { useT } from '@/i18n/t';

function LightVelaLogo() {
  // 高度 26px，宽度按 svg viewBox (131:28) 自适应 ≈ 121.6px。
  // 用 <img> 引用 public/ 下的 SVG 文件，未来替换 logo 只换图不动代码。
  return (
    <img
      src="/lightvela-wordmark.svg"
      alt="LightVela"
      className="h-[26px] w-auto block select-none"
      draggable={false}
    />
  );
}


export default function FooterSection() {
  const t = useT();
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
          {t("© 2026 LightVela 版权所有，由腾讯轻量云团队出品")}
        </p>
      </div>
    </footer>
  );
}
