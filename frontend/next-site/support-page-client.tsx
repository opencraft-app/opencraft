'use client';

import { usePathname } from 'next/navigation';

import {
  DEFAULT_PUBLIC_ROUTE_LOCALE,
  type PublicRouteLocale,
} from './public-locale';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { renderNextLanguageSwitcher } from './language-switcher';
import { PublicSiteLocaleBridge } from './public-site-providers';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';
import { SupportPage } from './support-page';

/**
 * Support / 反馈工单页面客户端壳
 *
 * 对齐 About / Changelog 等公开页面模式：
 *   - 不需要登录
 *   - 使用公开站导航栏（PublicSiteHeader）
 *   - 通过 PublicSiteLocaleBridge 提供 locale 上下文
 */
export function SupportPageClient({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}): React.ReactElement {
  const pathname = usePathname() || '/';

  return (
    <PublicSiteLocaleBridge locale={locale}>
      <SupportPage
        authControls={<PublicHeaderAuthIsland locale={locale} />}
        currentPath={pathname}
        publicLocale={locale}
        publicLocalized={localized}
        renderLink={renderNextPublicSiteHeaderLink}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
      />
    </PublicSiteLocaleBridge>
  );
}
