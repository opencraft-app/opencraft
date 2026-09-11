'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { PUBLIC_SITE_NAV_ITEMS, publicSiteHref, type PublicSiteLocale } from '@/lib/public-site-navigation';
import { isGlobal } from '@/lib/region';

const menuCopy: Record<PublicSiteLocale, [string, string]> = {
  'en-US': ['Open menu', 'Close menu'],
  'zh-CN': ['打开菜单', '关闭菜单'],
  'zh-SG': ['打开菜单', '关闭菜单'],
  'zh-Hant': ['開啟選單', '關閉選單'],
  'id-ID': ['Buka menu', 'Tutup menu'],
  es: ['Abrir menú', 'Cerrar menú'],
  'ja-JP': ['メニューを開く', 'メニューを閉じる'],
  'ko-KR': ['메뉴 열기', '메뉴 닫기'],
};

export function HomeMobileNavigation({ locale }: { locale: PublicSiteLocale }) {
  const [open, setOpen] = useState(false);
  const [openLabel, closeLabel] = menuCopy[locale];

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1100px)');
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="home-mobile-menu-trigger" aria-label={openLabel} title={openLabel}>
          <Menu size={22} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="home-mobile-menu-overlay" />
        <Dialog.Content className="home-mobile-menu" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{openLabel}</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="home-mobile-menu-close" aria-label={closeLabel} title={closeLabel}>
              <X size={22} aria-hidden="true" />
            </button>
          </Dialog.Close>
          <nav aria-label={openLabel}>
            {PUBLIC_SITE_NAV_ITEMS.filter((item) => !item.cnOnly || !isGlobal).map((item) => (
              <Dialog.Close asChild key={item.section}>
                <a href={publicSiteHref(item.href, locale, { localized: isGlobal })}>{item.label[locale]}</a>
              </Dialog.Close>
            ))}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
