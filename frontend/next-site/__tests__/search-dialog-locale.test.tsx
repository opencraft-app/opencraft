import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameworkProvider } from 'fumadocs-core/framework';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import { LightVelaSearchDialog } from '../lightvela-search-dialog';

const route = vi.hoisted(() => ({ pathname: '/th-th/docs/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('fumadocs-core/search/client', () => ({ useDocsSearch: () => ({ search: '', setSearch: vi.fn(), query: { data: 'empty', isLoading: false } }) }));
vi.mock('fumadocs-core/search/client/orama-static', () => ({ oramaStaticClient: vi.fn(() => ({})) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('search dialog locale outside the document provider', () => {
  it.each([
    ['/th-th/docs/', 'ค้นหา', 'ปิดการค้นหา'],
    ['/en-us/docs/', 'Search', 'Close Search'],
  ])('uses the %s route for portal chrome', (pathname, title, close) => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    route.pathname = pathname;
    render(<FrameworkProvider usePathname={() => route.pathname} useParams={() => ({})} useRouter={() => ({ push: vi.fn(), refresh: vi.fn() })}><I18nProvider locale="en-us"><LightVelaSearchDialog open onOpenChange={vi.fn()} /></I18nProvider></FrameworkProvider>);
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: close })).toBeInTheDocument();
  });
});
