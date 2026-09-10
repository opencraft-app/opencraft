import type { Metadata } from 'next';

import { SignInPageClient } from '@next-site/sign-in-page-client';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: {
    index: false,
    follow: false,
  },
};

export default function SignInRoute() {
  return <SignInPageClient />;
}
