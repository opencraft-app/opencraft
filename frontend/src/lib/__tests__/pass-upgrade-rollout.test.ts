import { describe, expect, it } from 'vitest';
import { isPassUpgradeVisible } from '../pass-upgrade-rollout';

describe('pass upgrade rollout', () => {
  const canary = 'usr_143e96b636afd48b3addc752';
  it('only exposes the domestic production entry to the approved user', () => {
    expect(isPassUpgradeVisible(canary, 'lightvela.com')).toBe(true);
    expect(isPassUpgradeVisible('another-user', 'lightvela.com')).toBe(false);
    expect(isPassUpgradeVisible(undefined, 'lightvela.com')).toBe(false);
  });
  it('does not enable international production or unknown hosts', () => {
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
