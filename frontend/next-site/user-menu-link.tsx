'use client';

import type { RenderPublicSiteHeaderLink } from '@/components/site/public-site-header';

export const renderNextPublicSiteHeaderLink: RenderPublicSiteHeaderLink = ({
  ariaLabel,
  children,
  ...props
}) => (
  <a {...props} aria-label={ariaLabel}>
    {children}
  </a>
);
