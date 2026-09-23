import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeMobileNavigation } from '@next-site/home-mobile-navigation';
import { isGlobal } from '@/lib/region';

const replace = vi.hoisted(() => vi.fn());
const setLocale = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en-US' } }) }));
vi.mock('@/i18n', () => ({ setLocale }));

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  window.history.replaceState(null, '', isGlobal ? '/zh-hant/' : '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  replace.mockReset();
  setLocale.mockReset();
});

describe('HomeMobileNavigation', () => {
  it('opens the mobile menu and switches language with the existing site routing', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<HomeMobileNavigation locale={isGlobal ? 'zh-Hant' : 'zh-CN'} />);

    fireEvent.click(screen.getByRole('button', { name: isGlobal ? '開啟選單' : '打开菜单' }));

    expect(screen.getByRole('region', { name: isGlobal ? '語言' : '语言' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Intl - English' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中国站' })).toBeInTheDocument();

    if (isGlobal) {
      fireEvent.click(screen.getByRole('button', { name: 'Intl - Español' }));
      expect(replace).toHaveBeenCalledWith('/es/');
      expect(setLocale).toHaveBeenCalled();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Intl - English' }));
      expect(open).toHaveBeenCalledWith('https://lightvela.ai/', '_blank', 'noopener,noreferrer');
    }
  });
});
