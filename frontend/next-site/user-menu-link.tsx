'use client';

import Link from 'next/link';

import type { RenderPublicSiteHeaderLink } from '@/components/site/public-site-header';

export const renderNextPublicSiteHeaderLink: RenderPublicSiteHeaderLink = ({
  ariaLabel,
  children,
  ...props
}) => (
  <Link {...props} aria-label={ariaLabel}>
    {children}
  </Link>
);
