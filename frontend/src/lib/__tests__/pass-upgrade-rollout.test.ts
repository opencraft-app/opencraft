import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { isPassUpgradeVisible, usePassUpgradeVisible } from '../pass-upgrade-rollout';

const controls = window as unknown as { show: () => void; hide: () => void };
beforeEach(() => { controls.hide(); vi.unstubAllGlobals(); });

describe('pass upgrade rollout', () => {
  const canary = 'usr_143e96b636afd48b3addc752';
  it('defaults to hidden and allows any signed-in user to reveal it', () => {
    expect(isPassUpgradeVisible(canary, 'lightvela.com')).toBe(false);
    controls.show();
    expect(isPassUpgradeVisible(canary, 'lightvela.com')).toBe(true);
    expect(isPassUpgradeVisible('another-user', 'lightvela.com')).toBe(true);
    expect(isPassUpgradeVisible(undefined, 'lightvela.com')).toBe(false);
    controls.hide();
    expect(isPassUpgradeVisible(canary, 'lightvela.com')).toBe(false);
  });
  it('updates mounted consumers immediately without a reload', () => {
    vi.stubGlobal('location', { hostname: 'lightvela.com' });
    const { result } = renderHook(() => usePassUpgradeVisible('any-user'));
    expect(result.current).toBe(false);
    act(() => controls.show());
    expect(result.current).toBe(true);
    act(() => controls.hide());
    expect(result.current).toBe(false);
  });
  it('does not enable international production or unknown hosts', () => {
    controls.show();
    for (const host of ['lightvela.ai', 'www.lightvela.ai', 'evil.example', 'lightvela.com.evil.example', '']) {
      expect(isPassUpgradeVisible(canary, host)).toBe(false);
    }
  });
  it('preserves explicit local and Beijing test access', () => {
    for (const host of ['localhost', '127.0.0.1', 'lightclaw.pages.dev']) {
      expect(isPassUpgradeVisible('test-user', host)).toBe(true);
      expect(isPassUpgradeVisible(undefined, host)).toBe(false);
    }
  });
});
