'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';

import {
  AppNavigationProvider,
  targetToHref,
  type AppLinkProps,
  type AppNavigationValue,
} from '@/lib/app-navigation';

const NextAppLink = ({ to, children, target, ...props }: AppLinkProps) => (
  <Link href={to} target={target} {...props}>
    {children}
  </Link>
);

export function NextAppNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const searchParams = useSearchParams();
  const search = searchParams.size > 0 ? `?${searchParams.toString()}` : '';

  const value = useMemo<AppNavigationValue>(() => ({
    Link: NextAppLink,
    navigate(target, options) {
      const href = targetToHref(target);
      if (options?.replace) {
        router.replace(href);
        return;
      }
      router.push(href);
    },
    pathname,
    search,
    setSearchParams(next, options) {
      const nextSearch = next.toString();
      const href = `${pathname}${nextSearch ? `?${nextSearch}` : ''}`;
      if (options?.replace) {
        router.replace(href);
        return;
      }
      router.push(href);
    },
  }), [pathname, router, search]);

  return <AppNavigationProvider value={value}>{children}</AppNavigationProvider>;
}
