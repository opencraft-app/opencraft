'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';

import { LoginModal } from '@/components/site/login-modal';
import type { HeaderAppearance } from '@/components/site/public-site-header';
import { UserAvatarMenu } from '@/components/site/user-avatar-menu';
import { useOpenClaw } from '@/contexts/openclaw-context';
import { useSession } from '@/contexts/session-context';
import { oauthErrorMessage } from '@/lib/oauth';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import { AGENTS_HOME_PATH, getAgentCreatingPath } from '@/lib/agent-routes';

import { renderNextLanguageSwitcher } from './language-switcher';

const secondaryButtonClass: Record<HeaderAppearance, string> = {
  immersive: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
  solid: 'border border-[#E6E9EF] bg-[#F5F5F5] text-black/90 hover:bg-black/5',
};

const copyByLocale: Record<PublicSiteLocale, { createNow: string; login: string }> = {
  'en-US': {
    createNow: 'Create Now',
    login: 'Sign In',
  },
  'zh-CN': {
    createNow: '立即创建',
    login: '登录',
  },
  'zh-SG': {
    createNow: '立即创建',
    login: '登录',
  },
};

type PublicHeaderAuthIslandProps = {
  appearance?: HeaderAppearance;
  locale?: PublicSiteLocale;
  oauthError?: string | null;
  showLanguageSwitcher?: boolean;
};

function PublicHeaderAuthControls({
  appearance = 'solid',
  locale,
  oauthError = null,
  showLanguageSwitcher = isGlobal,
}: PublicHeaderAuthIslandProps) {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { authReady, isAuthenticated } = useSession();
  const { bots, isSubscribed } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const activeLocale: PublicSiteLocale = locale ?? (i18n.language?.startsWith('zh') ? 'zh-SG' : 'en-US');
  const copy = copyByLocale[activeLocale] || copyByLocale['en-US'];

  useEffect(() => {
    if (oauthError) {
      setShowLogin(true);
    }
  }, [oauthError]);

  const goToCreate = () => {
    if (!isAuthenticated) {
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
        <div className="hidden shrink-0 items-center gap-3 md:flex" aria-hidden="true">
          <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />
          <span className="h-[36px] w-[64px] rounded-[100px] bg-black/[0.04]" />
          {showLanguageSwitcher && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
        </div>
        <div className="ml-auto flex items-center gap-2 md:hidden" aria-hidden="true">
          <span className="h-[32px] w-[58px] rounded-[100px] bg-black/[0.05]" />
        </div>
      </>
    );
  }

  if (isAuthenticated) {
    return (
      <>
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
          <UserAvatarMenu />
        </div>
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <UserAvatarMenu />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="hidden shrink-0 items-center gap-3 md:flex">
        <button
          type="button"
          onClick={goToCreate}
          className="inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] border border-black/90 bg-black/90 px-5 font-heading text-sm font-medium text-white shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-all hover:-translate-y-[1px] hover:shadow-lg"
        >
          {copy.createNow}
        </button>
        <button
          type="button"
          onClick={() => setShowLogin(true)}
          className={cn(
            'inline-flex h-[36px] cursor-pointer items-center justify-center whitespace-nowrap rounded-[100px] px-4 font-heading text-sm font-medium shadow-[0_2px_0_rgba(187,187,187,0.05)] transition-colors',
            secondaryButtonClass[appearance],
          )}
        >
          {copy.login}
        </button>
        {showLanguageSwitcher && renderNextLanguageSwitcher({ activeLocale: activeLocale, reloadAfterSwitch: false, variant: 'dropdown' })}
      </div>
      <div className="ml-auto flex items-center gap-2 md:hidden">
        <button
          type="button"
          onClick={() => setShowLogin(true)}
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
