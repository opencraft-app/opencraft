'use client';

import { ArrowLeft } from 'lucide-react';
import { Suspense, useEffect, useState, type ReactNode } from 'react';

import { LoginModal } from '@/components/site/login-modal';
import { LegalFooter } from '@/components/site/legal-footer';
import { ProductReturnHomeHeader } from '@/components/site/product-chrome';
import { useSession } from '@/contexts/session-context';
import { useT } from '@/i18n/t';
import { useAppNavigate } from '@/lib/app-navigation';
import { RumUserBridge } from '@/observability/rum-user-bridge';
import { ThemeStyleInjector } from '@/theme/theme-style';

import { NextAppNavigationProvider } from './next-app-navigation';

const LOCAL_PREVIEW_AUTH_ENABLED =
  process.env.NEXT_PUBLIC_LOCAL_PREVIEW_AUTH === '1'
  || process.env.VITE_LOCAL_PREVIEW_AUTH === '1';

function SkeletonBlock({ className }: { className: string }) {
  return <span className={`block animate-pulse bg-black/[0.045] ${className}`} />;
}

export function AgentsRouteLoading() {
  return (
    <div className="flex min-h-dvh flex-col bg-[#F7F8FA] text-[var(--text-primary)]">
      <ProductReturnHomeHeader />
      <main className="lw-app-top-pad flex-grow pb-12" aria-hidden="true">
        <section className="lw-settings-shell">
          <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="lg:sticky lg:top-[84px]">
              <div className="rounded-md border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
                <div className="flex items-center gap-3 rounded-md px-2.5 py-2.5">
                  <SkeletonBlock className="h-10 w-10 flex-shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <SkeletonBlock className="h-4 w-28 rounded" />
                    <div className="flex items-center gap-1.5">
                      <SkeletonBlock className="h-1.5 w-1.5 rounded-full" />
                      <SkeletonBlock className="h-3 w-14 rounded" />
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <SkeletonBlock className="h-7 w-6 rounded-md" />
                    <SkeletonBlock className="h-7 w-6 rounded-md" />
                  </div>
                </div>
                <SkeletonBlock className="mt-3 h-9 w-full rounded-md" />
              </div>

              <nav className="mt-4 rounded-md border border-black/[0.06] bg-white p-2 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 ${index === 0 ? 'bg-black/[0.035]' : ''}`}
                  >
                    <SkeletonBlock className="h-5 w-5 rounded" />
                    <SkeletonBlock className={index === 6 ? 'h-4 w-20 rounded' : 'h-4 w-14 rounded'} />
                    {index === 7 ? <SkeletonBlock className="ml-auto h-3 w-7 rounded-full" /> : null}
                  </div>
                ))}
              </nav>
            </aside>

            <section className="min-w-0">
              <div className="_lh-claw-bot-panel">
                <div className="_lh-claw-bot-panel__cards min-w-0">
                  <div className="rounded-md border border-black/[0.06] bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-2.5">
                        <SkeletonBlock className="h-5 w-36 rounded" />
                        <SkeletonBlock className="h-3.5 w-56 max-w-full rounded" />
                      </div>
                      <div className="flex gap-2">
                        <SkeletonBlock className="h-9 w-24 rounded-md" />
                        <SkeletonBlock className="h-9 w-20 rounded-md" />
                      </div>
                    </div>
                    <div className="mt-6 grid gap-3 md:grid-cols-3">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <div key={index} className="rounded-md border border-black/[0.05] bg-black/[0.012] p-4">
                          <SkeletonBlock className="h-3.5 w-16 rounded" />
                          <SkeletonBlock className="mt-3 h-6 w-24 rounded" />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 rounded-md border border-black/[0.06] bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
                    <div className="flex flex-wrap gap-2 border-b border-black/[0.06] pb-4">
                      <SkeletonBlock className="h-8 w-24 rounded-md" />
                      <SkeletonBlock className="h-8 w-24 rounded-md" />
                      <SkeletonBlock className="h-8 w-20 rounded-md" />
                    </div>
                    <div className="mt-5 space-y-4">
                      {Array.from({ length: 4 }).map((_, index) => (
                        <div key={index} className="grid gap-3 rounded-md border border-black/[0.05] px-4 py-3 sm:grid-cols-[160px_minmax(0,1fr)_96px] sm:items-center">
                          <SkeletonBlock className="h-4 w-24 rounded" />
                          <SkeletonBlock className={`h-4 rounded ${index % 2 === 0 ? 'w-4/5' : 'w-3/5'}`} />
                          <SkeletonBlock className="h-8 w-20 rounded-md" />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}

export function AccountRouteLoading() {
  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: 'var(--lw-fg)' }}>
      <ProductReturnHomeHeader />
      <main className="relative z-10 flex-grow pb-8 pt-20 md:pt-24" aria-hidden="true">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
          <SkeletonBlock className="mb-6 h-10 w-32 rounded-md" />

          <div className="overflow-hidden rounded-2xl border border-[#E6E9EF] bg-white">
            <div className="flex flex-col gap-5 border-b border-[#E6E9EF] px-5 py-6 md:flex-row md:items-center md:justify-between md:gap-4 md:px-8 md:py-8">
              <div className="flex items-center gap-4 md:gap-[22px]">
                <SkeletonBlock className="h-14 w-14 flex-shrink-0 rounded-full" />
                <div className="min-w-0 space-y-2.5">
                  <SkeletonBlock className="h-7 w-44 max-w-[52vw] rounded" />
                  <SkeletonBlock className="h-3.5 w-32 rounded" />
                </div>
              </div>
              <SkeletonBlock className="h-9 w-24 rounded-full" />
            </div>

            <div className="space-y-8 px-5 py-8 md:px-8">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="flex items-center justify-between gap-4">
                  <SkeletonBlock className="h-4 w-20 flex-shrink-0 rounded" />
                  <div className="flex min-w-0 items-center justify-end gap-2">
                    <SkeletonBlock className={index === 0 ? 'h-4 w-64 max-w-[48vw] rounded' : 'h-4 w-44 max-w-[48vw] rounded'} />
                    {index === 0 ? <SkeletonBlock className="h-7 w-7 flex-shrink-0 rounded-lg" /> : null}
                    {index === 1 ? <SkeletonBlock className="h-6 w-14 flex-shrink-0 rounded-full" /> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-[#E6E9EF] bg-white p-5 md:p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-2">
                <SkeletonBlock className="h-5 w-24 rounded" />
                <SkeletonBlock className="h-3.5 w-52 max-w-[55vw] rounded" />
              </div>
              <SkeletonBlock className="h-9 w-20 rounded-full" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export function AccountOrdersRouteLoading() {
  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: 'var(--lw-fg)' }}>
      <ProductReturnHomeHeader />
      <main className="relative z-10 flex-grow pb-16 pt-24" aria-hidden="true">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 960 }}>
          <SkeletonBlock className="mb-5 h-5 w-24 rounded" />
          <div className="mb-6 flex items-start justify-between gap-4">
            <div className="space-y-2">
              <SkeletonBlock className="h-8 w-28 rounded" />
              <SkeletonBlock className="h-4 w-48 rounded" />
            </div>
            <SkeletonBlock className="h-10 w-28 rounded-lg" />
          </div>
          <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-white">
            <div className="grid grid-cols-[1.2fr_1fr_0.8fr_1fr] gap-4 border-b border-black/[0.06] bg-black/[0.02] px-4 py-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <SkeletonBlock key={index} className="h-4 w-20 rounded" />
              ))}
            </div>
            <div className="divide-y divide-black/[0.04]">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="grid grid-cols-[1.2fr_1fr_0.8fr_1fr] gap-4 px-4 py-4">
                  <SkeletonBlock className="h-4 w-24 rounded" />
                  <SkeletonBlock className="h-4 w-28 rounded" />
                  <SkeletonBlock className="h-4 w-16 rounded" />
                  <SkeletonBlock className="h-5 w-14 rounded-md" />
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export function ProductSetupRouteLoading() {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <ProductReturnHomeHeader reloadLanguageAfterSwitch />
      <main className="flex-1 px-6 pb-16 pt-[92px] md:px-10 lg:px-20" aria-hidden="true">
        <div className="mx-auto max-w-[1180px] space-y-5">
          <div className="space-y-3">
            <SkeletonBlock className="h-6 w-28 rounded-full" />
            <SkeletonBlock className="h-10 w-80 max-w-full rounded" />
            <SkeletonBlock className="h-4 w-[560px] max-w-full rounded" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
            <div className="rounded-2xl border border-black/[0.06] bg-white/80 p-5">
              <SkeletonBlock className="h-5 w-36 rounded" />
              <div className="mt-6 space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <SkeletonBlock key={index} className="h-14 w-full rounded-xl" />
                ))}
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="rounded-2xl border border-black/[0.06] bg-white p-5">
                  <SkeletonBlock className="h-5 w-24 rounded" />
                  <SkeletonBlock className="mt-5 h-9 w-28 rounded" />
                  <div className="mt-6 space-y-3">
                    <SkeletonBlock className="h-4 w-full rounded" />
                    <SkeletonBlock className="h-4 w-4/5 rounded" />
                    <SkeletonBlock className="h-10 w-full rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function NextMarketingAuthGate({ children, loadingFallback }: { children: ReactNode; loadingFallback: ReactNode }) {
  const { authReady, isAuthenticated } = useSession();
  const [showLogin, setShowLogin] = useState(false);
  const t = useT();

  if (!authReady) {
    return <>{loadingFallback}</>;
  }

  if (isAuthenticated || LOCAL_PREVIEW_AUTH_ENABLED) {
    return <>{children}</>;
  }

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: 'var(--lw-fg)' }}>
      <main className="relative z-10 flex flex-grow items-center justify-center pb-8 pt-24">
        <div className="mx-auto flex max-w-md flex-col items-center px-6 text-center">
          <h2 className="text-xl font-bold" style={{ color: '#333', marginBottom: 16 }}>{t('请先登录')}</h2>
          <p className="text-sm leading-relaxed" style={{ color: '#999', marginBottom: 48 }}>
            {t('登录后即可创建和管理你的 Hermes Agent')}
          </p>
          <button
            type="button"
            onClick={() => setShowLogin(true)}
            className="lw-btn-primary"
          >
            {t('立即登录')}
          </button>
          <a href="/" className="lw-back-link" style={{ marginTop: 36 }}>
            <ArrowLeft className="h-3.5 w-3.5" /> {t('返回首页')}
          </a>
        </div>
      </main>
      <LegalFooter />
      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}

export function AppRouteShell({
  children,
  loadingFallback = <ProductSetupRouteLoading />,
  requireAuth = true,
}: {
  children: ReactNode;
  loadingFallback?: ReactNode;
  /**
   * 是否需要登录才能进入。默认 true（账号 / 订单 / 工作台 / 选套餐等页面强制登录）。
   * 定价页（subscribe）传 false：未登录用户可直接浏览静态价格，登录引导下沉到点「订阅」按钮时。
   */
  requireAuth?: boolean;
}) {
  const fallback = loadingFallback;

  return (
    <Suspense fallback={fallback}>
      <NextAppNavigationProvider>
        <RumUserBridge />
        <ThemeStyleInjector />
        {requireAuth ? (
          <NextMarketingAuthGate loadingFallback={fallback}>
            {children}
          </NextMarketingAuthGate>
        ) : (
          children
        )}
      </NextAppNavigationProvider>
    </Suspense>
  );
}

export function PlanSelectRouteShell({ children }: { children: ReactNode }) {
  const { planConfirmed } = useSession();
  const navigate = useAppNavigate();

  useEffect(() => {
    if (planConfirmed) {
      navigate('/', { replace: true });
    }
  }, [navigate, planConfirmed]);

  if (planConfirmed) {
    return <ProductSetupRouteLoading />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <ProductReturnHomeHeader reloadLanguageAfterSwitch />
      <main className="flex-1 px-6 pb-16 pt-[92px] md:px-10 lg:px-20">
        <div className="mx-auto max-w-[1180px]">
          {children}
        </div>
      </main>
      <LegalFooter />
    </div>
  );
}
