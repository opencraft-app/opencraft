'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type MouseEvent, type ReactNode } from 'react';

import {
  AppNavigationProvider,
  targetToHref,
  type AppLinkProps,
  type AppNavigationValue,
} from '@/lib/app-navigation';
import { shouldReloadForAgentChatNavigation } from '@/lib/agentchat-navigation-guard';

function reloadDocument(href: string, replace = false) {
  if (typeof window === 'undefined') return;
  if (replace) {
    window.location.replace(href);
    return;
  }
  window.location.assign(href);
}

const NextAppLink = ({ to, children, onClick, target, ...props }: AppLinkProps) => {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      target === '_blank'
    ) {
      return;
    }

    if (shouldReloadForAgentChatNavigation(to)) {
      event.preventDefault();
      reloadDocument(to);
    }
  };

  return (
    <Link href={to} target={target} onClick={handleClick} {...props}>
      {children}
    </Link>
  );
};

export function NextAppNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const searchParams = useSearchParams();
  const search = searchParams.size > 0 ? `?${searchParams.toString()}` : '';

  const value = useMemo<AppNavigationValue>(() => ({
    Link: NextAppLink,
    navigate(target, options) {
      const href = targetToHref(target);
      if (shouldReloadForAgentChatNavigation(href)) {
        reloadDocument(href, options?.replace);
        return;
      }
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
