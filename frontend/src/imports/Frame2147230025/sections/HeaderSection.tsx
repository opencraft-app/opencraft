import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  svgPaths } from '../assets';
import '../motion.css';
import { useT } from '@/i18n/t';
import { isGlobal, localizedPath } from '@/lib/region';
import { BrandMark } from '@/components/site/brand-mark';
import { LanguageSwitcher } from '@/components/site/language-switcher';
import { UserAvatarMenu } from '@/components/site/user-avatar-menu';
import { useSession } from '@/contexts/session-context';

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

function Component5({ onClick }: { onClick?: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("登录")}
      className="backdrop-blur-[8.05px] bg-[rgba(245,245,245,0.5)] hover:bg-[rgba(245,245,245,0.85)] hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] transition-all duration-200 ease-out content-stretch flex gap-[4px] items-center px-[24px] py-[7px] relative rounded-[100px] shrink-0 cursor-pointer border-0 outline-none"
      data-name="Component 53"
    >
      <div aria-hidden className="absolute border border-[#e6e9ef] border-solid inset-0 pointer-events-none rounded-[100px]" />
      <p className="lw-nav-login-text [word-break:break-word] font-['PingFang_SC:Medium',sans-serif] leading-[22px] not-italic relative shrink-0 text-[14px] text-[rgba(0,0,0,0.9)] text-center whitespace-nowrap">{t("登录")}</p>
    </button>
  );
}

function Component6({ onClick }: { onClick?: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("立即创建")}
      className="bg-[#161617] hover:bg-[#000] hover:-translate-y-[1px] hover:shadow-[0_8px_20px_rgba(0,0,0,0.25)] transition-all duration-200 ease-out content-stretch flex gap-[8px] items-center justify-center px-[24px] py-[7px] relative rounded-[38px] shrink-0 cursor-pointer border-0 outline-none"
      data-name="Component 53"
    >
      <p className="lw-nav-create-text [word-break:break-word] font-['PingFang_SC:Medium',sans-serif] leading-[22px] not-italic relative shrink-0 text-[14px] text-center text-white whitespace-nowrap">{t("立即创建")}</p>
    </button>
  );
}

function HeaderAuthSkeleton() {
  return (
    <div
      aria-hidden
      className="content-stretch flex gap-[12px] items-center relative shrink-0"
      data-testid="landing-header-auth-loading"
    >
      <span className="h-[36px] w-[104px] rounded-[100px] bg-black/[0.06]" />
      <span className="h-[36px] w-[72px] rounded-[100px] bg-black/[0.04]" />
      {isGlobal && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
    </div>
  );
}

type HeaderAuthSnapshot = {
  authReady: boolean;
  isAuthenticated: boolean;
};

function Frame5({
  onLoginClick,
  onCreateClick,
  authSnapshot,
}: {
  onLoginClick?: () => void;
  onCreateClick?: () => void;
  authSnapshot: HeaderAuthSnapshot;
}) {
  const { authReady, isAuthenticated } = authSnapshot;

  if (!authReady) {
    return <HeaderAuthSkeleton />;
  }

  if (isAuthenticated) {
    return (
      <div className="content-stretch flex gap-[12px] items-center relative shrink-0">
        {isGlobal && <LanguageSwitcher />}
        <UserAvatarMenu />
      </div>
    );
  }

  return (
    <div className="content-stretch flex gap-[12px] items-center relative shrink-0">
      <Component6 onClick={onCreateClick} />
      <Component5 onClick={onLoginClick} />
      {/* 语言切换器：仅国际站展示，与原站点 LandingNavbar 逻辑一致 */}
      {isGlobal && <LanguageSwitcher />}
    </div>
  );
}

/** 顶部导航项配置（与现网 lightvela.com 保持一致）
 * 概览 → /  ·  更新日志 → /changelog（仅国内站）  ·  产品文档 → /docs/overview  ·  关于我们 → /about
 */
const NAV_LINKS = [
  { label: '概览', href: '/' },
  { label: '更新日志', href: '/changelog' },
  { label: '产品文档', href: '/docs/overview' },
  { label: '关于我们', href: '/about' },
];

function stripLocalePrefix(pathname: string): string {
  const normalized = pathname.replace(/^\/(en|zh)(?=\/|$)/, "") || "/";
  return normalized === "//" ? "/" : normalized;
}

function isNavLinkActive(href: string, pathname: string): boolean {
  const activePath = stripLocalePrefix(pathname);
  const activeHref = stripLocalePrefix(href);
  return activeHref === "/" ? activePath === "/" : activePath === activeHref || activePath.startsWith(`${activeHref}/`);
}

interface HeaderSectionProps {
  onLoginClick?: () => void;
  onCreateClick?: () => void;
  authSnapshot?: HeaderAuthSnapshot;
}

interface HeaderSectionContentProps extends HeaderSectionProps {
  authSnapshot: HeaderAuthSnapshot;
}

export function HeaderSectionContent({ onLoginClick, onCreateClick, authSnapshot }: HeaderSectionContentProps) {
  const location = useLocation();
  const t = useT();
  const { i18n } = useTranslation();
  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en-US";
  const sitePath = (href: string) => (href === "/" ? href : localizedPath(href, locale));

  return (
    <header className="lw-landing-header w-full absolute top-0 left-0 z-20">
      <div className="mx-auto flex h-[60px] max-w-[1440px] items-center justify-between px-6 md:px-10 lg:px-[80px] relative">
        {/* Logo */}
        <BrandMark to="/" />
        {/* 中间导航：绝对居中（仅大屏显示）
            点击跳转对应路由，hover 时轻微上抬 */}
        <nav className="hidden lg:flex gap-8 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {NAV_LINKS.filter((link) => !(isGlobal && link.href === '/changelog')).map((link) => {
            const href = sitePath(link.href);
            const active = isNavLinkActive(link.href, location.pathname);
            return (
              <Link
                key={link.href}
                to={href}
                className={`lw-nav-link text-[14px] font-['PingFang_SC:Medium',sans-serif] transition-all duration-200 ease-out hover:-translate-y-[2px] hover:text-black no-underline ${
                  active ? 'lw-nav-link--active text-black/90 font-semibold' : 'text-[rgba(0,0,0,0.7)]'
                }`}
              >
                {t(link.label)}
              </Link>
            );
          })}
        </nav>
        {/* 右侧按钮 */}
        <Frame5 onLoginClick={onLoginClick} onCreateClick={onCreateClick} authSnapshot={authSnapshot} />
      </div>
    </header>
  );
}

export default function HeaderSection({ onLoginClick, onCreateClick, authSnapshot }: HeaderSectionProps = {}) {
  const liveSession = useSession();

  return (
    <HeaderSectionContent
      onLoginClick={onLoginClick}
      onCreateClick={onCreateClick}
      authSnapshot={authSnapshot ?? liveSession}
    />
  );
}
