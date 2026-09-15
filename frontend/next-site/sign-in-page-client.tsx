'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignInPage } from '@/pages/auth/sign-in-page';

import { AppRouteShell } from './app-route-shell';

export function SignInPageClient() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('ref')) {
      router.replace('/?' + params.toString());
      return;
    }
    setChecked(true);
  }, [router]);
  if (!checked) return null;
  return (
    <AppRouteShell requireAuth={false} loadingFallback={null}>
      <SignInPage />
    </AppRouteShell>
  );
}
