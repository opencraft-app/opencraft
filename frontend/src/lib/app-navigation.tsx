'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react';

export type AppNavigateTarget = string | {
  hash?: string;
  pathname: string;
  search?: string;
};

export type AppNavigateOptions = {
  replace?: boolean;
};

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string;
};

type SearchParamsSetter = (next: URLSearchParams, options?: AppNavigateOptions) => void;

export type AppNavigationValue = {
  Link: ComponentType<AppLinkProps>;
  navigate: (target: AppNavigateTarget, options?: AppNavigateOptions) => void;
  pathname: string;
  search: string;
  setSearchParams: SearchParamsSetter;
};

const BrowserLink = ({ to, children, ...props }: AppLinkProps) => (
  <a href={to} {...props}>
    {children}
  </a>
);

function targetToHref(target: AppNavigateTarget): string {
  if (typeof target === 'string') return target;

  const search = target.search
    ? target.search.startsWith('?')
      ? target.search
      : `?${target.search}`
    : '';
  const hash = target.hash
    ? target.hash.startsWith('#')
      ? target.hash
      : `#${target.hash}`
    : '';

  return `${target.pathname}${search}${hash}`;
}

function createBrowserNavigationValue(): AppNavigationValue {
  const readPathname = () => (typeof window === 'undefined' ? '/' : window.location.pathname);
  const readSearch = () => (typeof window === 'undefined' ? '' : window.location.search);

  const navigate = (target: AppNavigateTarget, options?: AppNavigateOptions) => {
    if (typeof window === 'undefined') return;
    const href = targetToHref(target);
    if (options?.replace) {
      window.location.replace(href);
      return;
    }
    window.location.assign(href);
  };

  return {
    Link: BrowserLink,
    navigate,
    pathname: readPathname(),
    search: readSearch(),
    setSearchParams(next, options) {
      const pathname = readPathname();
      const search = next.toString();
      navigate(`${pathname}${search ? `?${search}` : ''}`, options);
    },
  };
}

const AppNavigationContext = createContext<AppNavigationValue | null>(null);

export function AppNavigationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: AppNavigationValue;
}) {
  return (
    <AppNavigationContext.Provider value={value}>
      {children}
    </AppNavigationContext.Provider>
  );
}

export function useAppNavigation() {
  return useContext(AppNavigationContext) ?? createBrowserNavigationValue();
}

export function useAppNavigate() {
  return useAppNavigation().navigate;
}

export function useAppLocation() {
  const { pathname, search } = useAppNavigation();
  return useMemo(() => ({ pathname, search }), [pathname, search]);
}

export function useAppSearchParams(): [URLSearchParams, SearchParamsSetter] {
  const { search, setSearchParams } = useAppNavigation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const setStableSearchParams = useCallback<SearchParamsSetter>(
    (next, options) => setSearchParams(next, options),
    [setSearchParams],
  );

  return [params, setStableSearchParams];
}

export function AppLink(props: AppLinkProps) {
  const { Link } = useAppNavigation();
  return <Link {...props} />;
}

export { targetToHref };
