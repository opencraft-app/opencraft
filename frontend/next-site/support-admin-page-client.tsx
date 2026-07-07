'use client';

import {
  DEFAULT_PUBLIC_ROUTE_LOCALE,
  type PublicRouteLocale,
} from './public-locale';
import { PublicSiteLocaleBridge } from './public-site-providers';
import { SupportAdminPage } from './support-admin-page';

/**
 * Support Admin 后台管理页面客户端壳（独立模式）
 *
 * 独立后台页面，但仍接入公共站点的 locale bridge，
 * 以支持国际站中英文切换。
 */
export function SupportAdminPageClient({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
}: Partial<PublicRouteLocale> = {}): React.ReactElement {
  return (
    <PublicSiteLocaleBridge locale={locale}>
      <SupportAdminPage />
    </PublicSiteLocaleBridge>
  );
}
