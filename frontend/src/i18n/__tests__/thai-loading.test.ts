import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../generated/thai-public-copy.json');
  vi.resetModules();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Thai public copy loading', () => {
  it.each(['global', 'cn'])('keeps %s callers independent of the catalog and waits for Thai copy before exposing UI resources', async (region) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_REGION', region);
    window.history.replaceState(null, '', '/');
    let complete: ((module: { default: Record<string, string> }) => void) | undefined;
    const catalog = new Promise<{ default: Record<string, string> }>((resolve) => { complete = resolve; });
    const loader = vi.fn(() => catalog);
    vi.doMock('../generated/thai-public-copy.json', loader);
    const runtime = await import('../index');
    const { getOverviewScenarioTaskPacks } = await import('@/pages/marketing/scenario-tasks/overview-packs');
    expect(getOverviewScenarioTaskPacks('en-US').length).toBeGreaterThan(0);
    expect(getOverviewScenarioTaskPacks('zh-CN').length).toBeGreaterThan(0);
    expect(loader).not.toHaveBeenCalled();
    const first = runtime.ensureLocaleDictionary('th-TH');
    const second = runtime.ensureLocaleDictionary('th-TH');
    if (region === 'global') runtime.setLocale('th-TH');
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(runtime.default.hasResourceBundle('th-TH', 'translation')).toBe(false);
    if (region === 'global') runtime.setLocale('en-US');
    complete?.({ default: { Home: 'หน้าหลัก' } });
    await Promise.all([first, second]);
    expect(runtime.default.hasResourceBundle('th-TH', 'translation')).toBe(true);
    const { localizeThai } = await import('../thai-copy');
    expect(localizeThai('Home')).toBe('หน้าหลัก');
    if (region === 'global') expect(runtime.default.language).toBe('en-US');
  });

  it('retries a failed public catalog load', async () => {
    vi.resetModules();
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ default: { Home: 'หน้าหลัก' } });
    vi.doMock('../generated/thai-public-copy.json', loader);
    const { ensureThaiPublicCopy, localizeThai } = await import('../thai-copy');
    await expect(ensureThaiPublicCopy()).rejects.toThrow();
    vi.doMock('../generated/thai-public-copy.json', loader);
    await ensureThaiPublicCopy();
    expect(localizeThai('Home')).toBe('หน้าหลัก');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
