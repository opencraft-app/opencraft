import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../generated/malay-public-copy.json');
  vi.resetModules();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Malay public copy loading', () => {
  it.each(['global', 'cn'])('keeps %s callers independent of the catalog and waits for Malay copy before exposing UI resources', async (region) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_REGION', region);
    window.history.replaceState(null, '', '/');
    let complete: ((module: { default: Record<string, string> }) => void) | undefined;
    const catalog = new Promise<{ default: Record<string, string> }>((resolve) => { complete = resolve; });
    const loader = vi.fn(() => catalog);
    vi.doMock('../generated/malay-public-copy.json', loader);
    const runtime = await import('../index');
    const { getOverviewScenarioTaskPacks } = await import('@/pages/marketing/scenario-tasks/overview-packs');
    expect(getOverviewScenarioTaskPacks('en-US').length).toBeGreaterThan(0);
    expect(getOverviewScenarioTaskPacks('zh-CN').length).toBeGreaterThan(0);
    expect(loader).not.toHaveBeenCalled();
    const first = runtime.ensureLocaleDictionary('ms-MY');
    const second = runtime.ensureLocaleDictionary('ms-MY');
    if (region === 'global') runtime.setLocale('ms-MY');
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(runtime.default.hasResourceBundle('ms-MY', 'translation')).toBe(false);
    if (region === 'global') runtime.setLocale('en-US');
    complete?.({ default: { Home: 'Laman Utama' } });
    await Promise.all([first, second]);
    expect(runtime.default.hasResourceBundle('ms-MY', 'translation')).toBe(true);
    const { localizeMalay } = await import('../malay-copy');
    expect(localizeMalay('Home')).toBe('Laman Utama');
    if (region === 'global') expect(runtime.default.language).toBe('en-US');
  });

  it('retries a failed public catalog load', async () => {
    vi.resetModules();
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ default: { Home: 'Laman Utama' } });
    vi.doMock('../generated/malay-public-copy.json', loader);
    const { ensureMalayPublicCopy, localizeMalay } = await import('../malay-copy');
    await expect(ensureMalayPublicCopy()).rejects.toThrow();
    vi.doMock('../generated/malay-public-copy.json', loader);
    await ensureMalayPublicCopy();
    expect(localizeMalay('Home')).toBe('Laman Utama');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
