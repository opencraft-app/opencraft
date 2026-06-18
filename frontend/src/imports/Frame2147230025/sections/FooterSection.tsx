import { useT } from '@/i18n/t';
import { BEIAN_URL, ICP_LICENSE, shouldShowICP } from '@/constants/legal';
import { LightVelaFooter } from '@/components/site/lightvela-footer';
import { isGlobal } from '@/lib/region';

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
  const showICP = shouldShowICP();

  if (isGlobal) {
    return <LightVelaFooter />;
  }

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

        {/* 右：版权文字与备案号 */}
        <div className="flex items-center gap-4 font-['Noto_Sans_SC:Regular',sans-serif] font-normal leading-[22px] text-[14px] text-[rgba(51,65,85,0.7)] whitespace-nowrap">
          <p>{t("© 2026 LightVela 版权所有，由腾讯轻量云团队出品")}</p>
          {showICP && (
            <a
              href={BEIAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[rgba(51,65,85,0.95)]"
            >
              {ICP_LICENSE}
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
