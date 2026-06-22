'use client';

import Link from 'next/link';

import type { RenderPublicSiteHeaderLink } from '@/components/site/public-site-header';
import type { RenderUserMenuLink } from '@/components/site/user-avatar-menu';

export const renderNextUserMenuLink: RenderUserMenuLink = ({ children, ...props }) => (
  <Link {...props}>{children}</Link>
);

export const renderNextPublicSiteHeaderLink: RenderPublicSiteHeaderLink = ({
  ariaLabel,
  children,
  ...props
}) => (
  <Link {...props} aria-label={ariaLabel}>
    {children}
  </Link>
);
