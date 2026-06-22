'use client';

import { useMemo, type ReactNode } from 'react';
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  type NavigateOptions,
} from 'react-router-dom';

import {
  AppNavigationProvider,
  targetToHref,
  type AppLinkProps,
  type AppNavigationValue,
} from '@/lib/app-navigation';

const ReactRouterLink = ({ to, children, ...props }: AppLinkProps) => (
  <RouterLink to={to} {...props}>
    {children}
  </RouterLink>
);

export function ReactRouterAppNavigationProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  const value = useMemo<AppNavigationValue>(() => ({
    Link: ReactRouterLink,
    navigate(target, options) {
      navigate(targetToHref(target), options as NavigateOptions);
    },
    pathname: location.pathname,
    search: location.search,
    setSearchParams(next, options) {
      const search = next.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}${location.hash}`, options as NavigateOptions);
    },
  }), [location.hash, location.pathname, location.search, navigate]);

  return <AppNavigationProvider value={value}>{children}</AppNavigationProvider>;
}
