import type { BrowserDeviceProfile } from '@opencraft/browser-core';

interface ClientDevice {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: { readonly platform?: string; readonly mobile?: boolean };
}

/** Send a bounded device identity, never the client's arbitrary UA or DPR. */
export function remoteBrowserDeviceProfile(
  client: ClientDevice = typeof navigator === 'undefined' ? {} : navigator,
): BrowserDeviceProfile {
  const ua = client.userAgent ?? '', platform = client.platform ?? '';
  if (/iPhone|iPod/i.test(ua)) return 'iphone';
  if (/iPad/i.test(ua) || platform === 'MacIntel' && (client.maxTouchPoints ?? 0) > 1) return 'ipad';
  if (/Android/i.test(ua) || client.userAgentData?.platform === 'Android')
    return /Mobile/i.test(ua) || client.userAgentData?.mobile === true ? 'android-phone' : 'android-tablet';
  return (client.maxTouchPoints ?? 0) > 0 ? 'desktop-touch' : 'desktop';
}
