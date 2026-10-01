'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';

import type { HeaderAppearance } from '@/components/site/public-site-header';
import { useOpenClaw } from '@/contexts/agent-context';
import { useRepositories } from '@/contexts/repository-context';
import { useSession } from '@/contexts/session-context';
import { oauthErrorMessage } from '@/lib/oauth';
import { type PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import { AGENTS_HOME_PATH } from '@/lib/agent-routes';
import { CTA_COPY_BY_LOCALE, journeyHref, resolveCtaRoute } from '@/lib/cta-journey';
import {
  armPostLoginRedirect,
  disarmPostLoginRedirect,
  REOPEN_PRICING_MODAL_EVENT,
  usePostLoginRedirect,
} from './use-post-login-redirect';
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
 * Header 文案表。未登录转化引导的「免费试用 / Free trial」统一取自
 * `CTA_COPY_BY_LOCALE`，与 Hero / Footer CTA 共用同一份文案，避免两处漂移。
 */
const copyByLocale: Record<
  PublicSiteLocale,
  { createNow: string; enterProduct: string; login: string }
> = {
  'en-US': {
    createNow: 'Create Now',
    enterProduct: 'Enter LightVela',
    login: 'Sign In',
  },
  'zh-CN': {
    createNow: '立即创建',
    enterProduct: '开始使用',
    login: '登录',
  },
  'zh-SG': {
    createNow: '立即创建',
    enterProduct: '开始使用',
    login: '登录',
  },
  'zh-Hant': {
    createNow: '立即創建',
    enterProduct: '開始使用',
    login: '登入',
  },
  'id-ID': {
    createNow: 'Buat Sekarang',
    enterProduct: 'Masuk ke LightVela',
    login: 'Masuk',
  },
  es: {
    createNow: 'Crear ahora',
    enterProduct: 'Entrar a LightVela',
    login: 'Iniciar sesión',
  },
  'ja-JP': {
    createNow: '今すぐ作成',
    enterProduct: 'LightVelaを開く',
    login: 'ログイン',
  },
  'ko-KR': {
    createNow: '지금 만들기',
    enterProduct: 'LightVela 열기',
    login: '로그인',
  },
};

const entitlementErrorCopy: Record<PublicSiteLocale, { message: string; retry: string }> = {
  'en-US': { message: 'Could not confirm your subscription. Try again.', retry: 'Retry' },
  'zh-CN': { message: '订阅状态暂时无法确认，请重试。', retry: '重试' },
  'zh-SG': { message: '订阅状态暂时无法确认，请重试。', retry: '重试' },
  'zh-Hant': { message: '暫時無法確認訂閱狀態，請重試。', retry: '重試' },
  'id-ID': { message: 'Status langganan belum dapat dikonfirmasi. Coba lagi.', retry: 'Coba lagi' },
  es: { message: 'No se pudo confirmar tu suscripción. Inténtalo de nuevo.', retry: 'Reintentar' },
  'ja-JP': { message: 'サブスクリプションの状態を確認できません。再試行してください。', retry: '再試行' },
  'ko-KR': { message: '구독 상태를 확인할 수 없습니다. 다시 시도해 주세요.', retry: '다시 시도' },
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
  /** 精简未登录导航：隐藏创建入口，仅显示黑色登录主按钮。 */
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
  const { auth } = useRepositories();
  const { bots, botsError, botsLoading, hasResolvedPasses, isSubscribed, latestPass, passesError, passesLoading } = useOpenClaw();
  const [showLogin, setShowLogin] = useState(false);
  const [postLoginError, setPostLoginError] = useState(false);
  const loginErrorMessage = useMemo(() => oauthErrorMessage(oauthError), [oauthError]);
  const activeLocale = locale;
  const copy = copyByLocale[activeLocale];
  const hasBots = bots.length > 0;
  // 未登录转化引导：主按钮文案与 Hero / Footer CTA 共用同一份「免费试用」文案。
  // 可选链 + en-US 兜底，避免 CTA_COPY_BY_LOCALE 缺失对应语种时拿到 undefined（工蜂 AI CR 边界条件建议）。
  const createLabel = promoteFreeTrial
    ? (CTA_COPY_BY_LOCALE[activeLocale]?.startFree ?? CTA_COPY_BY_LOCALE['en-US'].startFree)
    : copy.createNow;
  // CTA / 登录落点：订阅前统一 /subscribe，订阅后统一 /agents（国内国际同一套逻辑）。
  // 当前没有 Bot 的已订阅用户直接进入创建流程。
  const ctaRoute = resolveCtaRoute({
    isAuthenticated,
    isSubscribed,
    hasBots,
  });
  const ctaHref = journeyHref(ctaRoute, activeLocale, { localized: isGlobal });
  // 登录成功后按订阅状态分流：未订阅 → /subscribe，已订阅 → /agents
  const redirectAfterLogin = usePostLoginRedirect({
    locale: activeLocale,
    onEntitlementUnavailable: () => setPostLoginError(true),
  });

  const renderProductEntry = (surface: 'desktop' | 'mobile') => {
    /* 购买前不暴露「我的智能体」入口（PRD 2026-09-30）。
       与 /agents 门禁同口径：已订阅、有历史订阅或 Bot 才显示。 */
    const hasExistingAssets = (bots?.length ?? 0) > 0 || Boolean(latestPass);
    if (!showProductEntry || !isAuthenticated || !hasResolvedPasses || passesLoading || passesError || botsLoading || botsError || (!isSubscribed && !hasExistingAssets)) return null;
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

  useEffect(() => {
    if (authReady && !isAuthenticated && new URLSearchParams(window.location.search).has('ref')) {
      setShowLogin(true);
    }
  }, [authReady, isAuthenticated]);

  useEffect(() => {
    if (!authReady || !isAuthenticated) return;
    const referralCode = new URLSearchParams(window.location.search).get('ref')?.trim().toUpperCase();
    if (!referralCode) return;
    void auth.prepareReferralCode(referralCode).catch(() => undefined);
  }, [auth, authReady, isAuthenticated]);

  const goToCreate = () => {
    // 方案 A（issue #73）：未登录直接进 /subscribe 看套餐，在订阅页点「订阅」时才引导登录，
    // 降低进套餐页的摩擦；已登录已订阅 → /agents，已登录未订阅 → /subscribe。
    // 落点统一由 ctaHref 表达（未登录时 resolveCtaRoute 返回 subscribe），因此不再强制先登录。
    trackDatongClick('header_create_now_btn', {
      pgid: DATONG_PAGE_IDS.HOME,
      params: {
        has_bots: hasBots,
        target: ctaRoute,
      },
    });
    if (promoteFreeTrial && ctaRoute === 'subscribe') {
      const event = new CustomEvent(REOPEN_PRICING_MODAL_EVENT, { detail: { handled: false } });
      window.dispatchEvent(event);
      if (event.detail.handled) return;
    }
    router.push(ctaHref);
  };

  if (!authReady) {
    return (
      <>
        <div className="hidden shrink-0 translate-x-6 items-center gap-2 lg:flex xl:gap-3" aria-hidden="true">
          {showLanguageSwitcher && <span className="h-[36px] w-[70px] rounded-[100px] bg-black/[0.04]" />}
          {!loginOnly && <span className="h-[36px] w-[96px] rounded-[100px] bg-black/[0.06]" />}
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
        {postLoginError && (
          <div role="alert" className="fixed right-4 top-20 z-[100] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg bg-white px-4 py-3 text-sm text-[#9f2332] shadow-lg ring-1 ring-[#9f2332]/20">
            <span>{entitlementErrorCopy[activeLocale].message}</span>
            <button
              type="button"
              className="shrink-0 font-semibold underline underline-offset-2"
              onClick={() => {
                setPostLoginError(false);
                redirectAfterLogin();
              }}
            >
              {entitlementErrorCopy[activeLocale].retry}
            </button>
          </div>
        )}
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
            // OAuth 整页跳转回跳后靠该意图分流；手机登录走 onSuccess。
            armPostLoginRedirect();
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
            // OAuth 整页跳转回跳后靠该意图分流；手机登录走 onSuccess。
            armPostLoginRedirect();
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
          onClose={() => {
            // 用户主动关闭且未登录成功：清除分流意图，避免下次回跳误触发。
            disarmPostLoginRedirect();
            setShowLogin(false);
          }}
          initialError={loginErrorMessage}
          onSuccess={() => {
            redirectAfterLogin();
          }}
        />
      )}
    </>
  );
}

export function PublicHeaderAuthIsland(props: PublicHeaderAuthIslandProps) {
  return <PublicHeaderAuthControls {...props} />;
}
