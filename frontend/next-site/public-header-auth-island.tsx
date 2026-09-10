'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';

import type { HeaderAppearance } from '@/components/site/public-site-header';
import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import { oauthErrorMessage } from '@/lib/oauth';
import { publicSiteHref, type PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import { AGENTS_HOME_PATH, getAgentCreatingPath } from '@/lib/agent-routes';
import { DATONG_PAGE_IDS } from '@/observability/datong';
import { trackDatongClick } from '@/observability/datong-tracker';

import { renderNextLanguageSwitcher } from './language-switcher';

const LoginModal = dynamic(() =>
  import('@/components/site/login-modal').then((module) => module.LoginModal),
);
const UserAvatarMenu = dynamic(() =>
  import('@/components/site/user-avatar-menu').then((module) => module.UserAvatarMenu),
);

const secondaryButtonClass: Record<HeaderAppearance, string> = {
  immersive: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
  solid: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
};

/**
 * 首屏体验优化：`authReady` 需要等待 Session 网络往返，期间头部只能显示骨架。
 * 这里把上一次已知的登录态缓存到 localStorage，客户端挂载后立即据此乐观渲染，
 * 把骨架停留时间从「一次网络往返」降到「一帧」。Session 返回后仍以真实结果为准。
 * 仅用于渲染时机优化，不参与任何鉴权判断。
 */
const LAST_AUTH_HINT_KEY = 'lightvela-last-auth-hint-v1';

function readLastAuthHint(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(LAST_AUTH_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeLastAuthHint(isAuthenticated: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_AUTH_HINT_KEY, isAuthenticated ? '1' : '0');
  } catch {
    /* 隐私模式或存储配额受限时忽略，仅影响首屏渲染时机 */
  }
}

const copyByLocale: Record<
  PublicSiteLocale,
  { createNow: string; enterProduct: string; freeTrial: string; login: string }
> = {
  'en-US': {
    createNow: 'Create Now',
    enterProduct: 'Enter LightVela',
    freeTrial: 'Free trial',
    login: 'Sign In',
  },
  'zh-CN': {
    createNow: '立即创建',
    enterProduct: '开始使用',
    freeTrial: '免费试用',
    login: '登录',
  },
  'zh-SG': {
    createNow: '立即创建',
    enterProduct: '开始使用',
    freeTrial: '免费试用',
    login: '登录',
  },
  'zh-Hant': {
    createNow: '立即創建',
    enterProduct: '開始使用',
    freeTrial: '免費試用',
    login: '登入',
  },
  'id-ID': {
    createNow: 'Buat Sekarang',
    enterProduct: 'Masuk ke LightVela',
    freeTrial: 'Coba Gratis',
    login: 'Masuk',
  },
  es: {
    createNow: 'Crear ahora',
    enterProduct: 'Entrar a LightVela',
    freeTrial: 'Prueba gratis',
    login: 'Iniciar sesión',
  },
  'ja-JP': {
    createNow: '今すぐ作成',
    enterProduct: 'LightVelaを開く',
    freeTrial: '無料で試す',
    login: 'ログイン',
  },
  'ko-KR': {
    createNow: '지금 만들기',
    enterProduct: 'LightVela 열기',
    freeTrial: '무료 체험',
    login: '로그인',
  },
};

type PublicHeaderAuthIslandProps = {
  appearance?: HeaderAppearance;
  locale: PublicSiteLocale;
  oauthError?: string | null;
  showLanguageSwitcher?: boolean;
  showProductEntry?: boolean;
  /**
   * 未登录转化引导：为 true 时右上角主按钮文案改为「免费试用」，
   * 未登录点击直接跳转订阅套餐页（而非弹出登录框）。仅首页启用。
   */
  promoteFreeTrial?: boolean;
  /** 仅显示黑色登录主按钮，供国际站首页的精简导航使用。 */
  loginOnly?: boolean;
};

function PublicHeaderAuthControls({
  appearance = 'solid',
  locale,
  oauthError = null,
  showLanguageSwitcher = isGlobal,
  showProductEntry = false,
  promoteFreeTrial = false,
  loginOnly = isGlobal,
}: PublicHeaderAuthIslandProps) {
  const router = useRouter();
  const { authReady, isAuthenticated } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  // null 表示尚未读取缓存（SSR 与首帧），此时保持骨架以避免 hydration 不一致。
  const [lastAuthHint, setLastAuthHint] = useState<boolean | null>(null);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const activeLocale = locale;
  const copy = copyByLocale[activeLocale];
  // 未登录转化引导：主按钮文案改为当前 locale 的「免费试用」。
  const createLabel = promoteFreeTrial ? copy.freeTrial : copy.createNow;
  const subscribePath = publicSiteHref('/subscribe', activeLocale, { localized: isGlobal });

  const renderProductEntry = (surface: 'desktop' | 'mobile') => {
    if (!showProductEntry) return null;
    const isMobile = surface === 'mobile';
    return (
      <a
        href={AGENTS_HOME_PATH}
        onClick={() => {
          trackDatongClick('agent_enter_console_btn', {
            pgid: DATONG_PAGE_IDS.HOME,
            params: { surface, target: AGENTS_HOME_PATH },
          });
        }}
        className={cn(
          'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 font-heading font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
          isMobile ? 'h-[32px] px-3 text-[13px]' : 'h-[36px] px-4 text-sm xl:px-5',
        )}
      >
        {copy.enterProduct}
      </a>
    );
  };

  useEffect(() => {
    if (oauthError) {
      setShowLogin(true);
    }
  }, [oauthError]);

  // 挂载后立即读取缓存，使骨架最多只出现一帧。
  useEffect(() => {
    setLastAuthHint(readLastAuthHint());
  }, []);

  // Session 就绪后回写真实结果，供下次访问首屏使用。
  useEffect(() => {
    if (authReady) writeLastAuthHint(isAuthenticated);
  }, [authReady, isAuthenticated]);

  const goToCreate = () => {
    const target = !isAuthenticated
      ? promoteFreeTrial
        ? subscribePath
        : 'login_modal'
      : isSubscribed
        ? bots.length > 0
          ? AGENTS_HOME_PATH
          : getAgentCreatingPath(true)
        : subscribePath;
    trackDatongClick('header_create_now_btn', {
      pgid: DATONG_PAGE_IDS.HOME,
      params: {
        has_bots: bots.length > 0,
        target,
      },
    });
    if (!isAuthenticated) {
      // 首页转化引导：未登录点击「免费试用」直接进入订阅套餐页；
      // 其它页面维持原有「弹出登录框」行为。
      if (promoteFreeTrial) {
        router.push(subscribePath);
        return;
      }
      setShowLogin(true);
      return;
    }
    if (isSubscribed) {
      router.push(bots.length > 0 ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
      return;
    }
    router.push(subscribePath);
  };

  /* 登录态解析优先级：真实 Session > localStorage 乐观提示 > 未知（骨架）。
     语言切换与登录态无关，任何阶段都直接渲染，不跟随 Session 等待。 */
  const resolvedAuthenticated = authReady ? isAuthenticated : lastAuthHint;

  if (resolvedAuthenticated === null) {
    return (
      <>
        <div className="hidden shrink-0 translate-x-6 items-center gap-2 lg:flex xl:gap-3">
          {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
          <span aria-hidden="true" className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
        </div>
        <div className="ml-auto flex items-center gap-2 lg:hidden" aria-hidden="true">
          <span className="h-[32px] w-[58px] rounded-[100px] bg-black/[0.05]" />
        </div>
      </>
    );
  }

  if (resolvedAuthenticated) {
    return (
      <>
        <div className="hidden shrink-0 items-center gap-2 lg:flex xl:gap-3">
          {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
          {renderProductEntry('desktop')}
          <UserAvatarMenu />
        </div>
        <div className="ml-auto flex items-center gap-2 lg:hidden">
          {renderProductEntry('mobile')}
          <UserAvatarMenu />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="hidden shrink-0 translate-x-6 items-center gap-2 lg:flex xl:gap-3">
        {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
        {!loginOnly && (
          <button
            type="button"
            onClick={goToCreate}
            className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 px-4 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg xl:px-5"
          >
            {createLabel}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            trackDatongClick('header_login_btn', { pgid: DATONG_PAGE_IDS.HOME });
            setShowLogin(true);
          }}
          className={cn(
            'inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] px-3 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors xl:px-4',
            loginOnly
              ? 'border border-black/90 bg-black/90 text-white hover:bg-black'
              : secondaryButtonClass[appearance],
          )}
        >
          {copy.login}
        </button>
      </div>
      <div className="ml-auto flex items-center gap-2 lg:hidden">
        <button
          type="button"
          onClick={() => {
            trackDatongClick('header_login_btn', {
              pgid: DATONG_PAGE_IDS.HOME,
              params: { surface: 'mobile' },
            });
            setShowLogin(true);
          }}
          className={cn(
            'inline-flex h-[32px] cursor-pointer items-center justify-center rounded-[100px] px-3 font-heading text-[13px] font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors',
            loginOnly
              ? 'border border-black/90 bg-black/90 text-white hover:bg-black'
              : secondaryButtonClass[appearance],
          )}
        >
          {copy.login}
        </button>
      </div>
      {showLogin && (
        <LoginModal
          open
          onClose={() => setShowLogin(false)}
          initialError={loginErrorMessage}
          onSuccess={() => {
            router.push(AGENTS_HOME_PATH);
          }}
        />
      )}
    </>
  );
}

export function PublicHeaderAuthIsland(props: PublicHeaderAuthIslandProps) {
  return <PublicHeaderAuthControls {...props} />;
}
