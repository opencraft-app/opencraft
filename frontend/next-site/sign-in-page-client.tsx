'use client';

import { SignInPage } from '@/pages/auth/sign-in-page';

import { AppRouteShell } from './app-route-shell';

export function SignInPageClient() {
  return (
    <AppRouteShell requireAuth={false} loadingFallback={null}>
      <SignInPage />
    </AppRouteShell>
  );
}
