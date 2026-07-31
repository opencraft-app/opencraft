'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';

import { LoginModal } from '@/components/site/login-modal';
import type { HeaderAppearance } from '@/components/site/public-site-header';
import { UserAvatarMenu } from '@/components/site/user-avatar-menu';
import { useOpenClaw } from '@/contexts/agent-context';
import { useSession } from '@/contexts/session-context';
import { oauthErrorMessage } from '@/lib/oauth';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import { AGENTS_HOME_PATH, getAgentCreatingPath } from '@/lib/agent-routes';
import { DATONG_PAGE_IDS } from '@/observability/datong';
import { trackDatongClick } from '@/observability/datong-tracker';

import { renderNextLanguageSwitcher } from './language-switcher';
import { EN_US_LOCALE, ZH_CN_LOCALE, ZH_HANT_LOCALE, ZH_SG_LOCALE } from './public-locale';

const secondaryButtonClass: Record<HeaderAppearance, string> = {
  immersive: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
  solid: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
};

const copyByLocale: Record<PublicSiteLocale, { createNow: string; login: string }> = {
  [EN_US_LOCALE]: {
    createNow: 'Create Now',
    login: 'Sign In',
  },
  [ZH_CN_LOCALE]: {
    createNow: '立即创建',
    login: '登录',
  },
  [ZH_SG_LOCALE]: {
    createNow: '立即创建',
    login: '登录',
  },
  [ZH_HANT_LOCALE]: {
    createNow: '立即創建',
    login: '登入',
  },
};

/**
 * 未显式传入 `locale` prop 时的兜底：从运行时 `i18n.language` 推断当前 locale。
 *
 * 注意繁体必须优先于「以 zh 开头」的简体判断 —— 否则 `zh-Hant` 会误落到
 * 简体 `ZH_SG_LOCALE`，导致繁体站头部按钮显示简体文案（「立即创建/登录」
 * 而非「立即創建/登入」）。
 */
function inferLocaleFromI18n(language: string | undefined): PublicSiteLocale {
  if (language === ZH_HANT_LOCALE || language?.startsWith('zh-Hant')) return ZH_HANT_LOCALE;
  if (language?.startsWith('zh')) return ZH_SG_LOCALE;
  return EN_US_LOCALE;
}

type PublicHeaderAuthIslandProps = {
  appearance?: HeaderAppearance;
  locale?: PublicSiteLocale;
  oauthError?: string | null;
  showLanguageSwitcher?: boolean;
  /**
   * 未登录转化引导：为 true 时右上角主按钮文案改为「免费试用」，
   * 未登录点击直接跳转订阅套餐页（而非弹出登录框）。仅首页启用。
   */
  promoteFreeTrial?: boolean;
};

function PublicHeaderAuthControls({
  appearance = 'solid',
  locale,
  oauthError = null,
  showLanguageSwitcher = isGlobal,
  promoteFreeTrial = false,
}: PublicHeaderAuthIslandProps) {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { authReady, isAuthenticated } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const activeLocale: PublicSiteLocale = locale ?? inferLocaleFromI18n(i18n.language);
  const copy = copyByLocale[activeLocale] || copyByLocale[EN_US_LOCALE];
  // 未登录转化引导：主按钮文案改为「免费试用」（英文站为 Free trial、繁体为「免費試用」）
  const createLabel = promoteFreeTrial
    ? activeLocale === ZH_HANT_LOCALE
      ? '免費試用'
      : activeLocale.startsWith('zh')
        ? '免费试用'
        : 'Free trial'
    : copy.createNow;

  useEffect(() => {
    if (oauthError) {
      setShowLogin(true);
    }
  }, [oauthError]);

  const goToCreate = () => {
    const target = !isAuthenticated
      ? promoteFreeTrial
        ? '/subscribe'
        : 'login_modal'
      : isSubscribed
        ? bots.length > 0
          ? AGENTS_HOME_PATH
          : getAgentCreatingPath(true)
        : '/subscribe';
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
        router.push('/subscribe');
        return;
      }
      setShowLogin(true);
      return;
    }
    if (isSubscribed) {
      router.push(bots.length > 0 ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
      return;
    }
    router.push('/subscribe');
  };

  if (!authReady) {
    return (
      <>
        <div className="hidden shrink-0 translate-x-6 items-center gap-2 lg:flex xl:gap-3" aria-hidden="true">
          {showLanguageSwitcher && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
          <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />
          <span className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
        </div>
        <div className="ml-auto flex items-center gap-2 lg:hidden" aria-hidden="true">
          <span className="h-[32px] w-[58px] rounded-[100px] bg-black/[0.05]" />
        </div>
      </>
    );
  }

  if (isAuthenticated) {
    return (
      <>
        <div className="hidden shrink-0 items-center gap-2 lg:flex xl:gap-3">
          {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
          <UserAvatarMenu />
        </div>
        <div className="ml-auto flex items-center gap-2 lg:hidden">
          <UserAvatarMenu />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="hidden shrink-0 translate-x-6 items-center gap-2 lg:flex xl:gap-3">
        {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
        <button
          type="button"
          onClick={goToCreate}
          className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 px-4 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg xl:px-5"
        >
          {createLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            trackDatongClick('header_login_btn', { pgid: DATONG_PAGE_IDS.HOME });
            setShowLogin(true);
          }}
          className={cn(
            'inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] px-3 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors xl:px-4',
            secondaryButtonClass[appearance],
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
            secondaryButtonClass[appearance],
          )}
        >
          {copy.login}
        </button>
      </div>
      <LoginModal
        open={showLogin}
        onClose={() => setShowLogin(false)}
        initialError={loginErrorMessage}
        onSuccess={() => {
          router.push(AGENTS_HOME_PATH);
        }}
      />
    </>
  );
}

export function PublicHeaderAuthIsland(props: PublicHeaderAuthIslandProps) {
  return <PublicHeaderAuthControls {...props} />;
}
