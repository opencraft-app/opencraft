import type { TrustedExtensionApiV1 } from '@opencraft/extension-runtime';
import type { TencentOaController } from './controller';
import { MobileGuide, mobileSiteUrl } from './mobile-guide';

export function registerMobileGuide(api: TrustedExtensionApiV1, controller: TencentOaController): void {
  if (typeof window === 'undefined' || window.parent !== window) return;
  const url = mobileSiteUrl(window.location.href);
  // Same primary-pointer capability used by the Web host's desktop/mobile
  // client presentation. No UA sniffing or viewport-width device inference.
  const desktop = window.matchMedia('(pointer: fine)');
  if (!url || !desktop.matches) return;
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* Private/restricted browser. */ }
  const guide = new MobileGuide({ storage, signal: api.signal, url, currentUrl: () => mobileSiteUrl(window.location.href),
    eligible: () => desktop.matches && controller.getSnapshot().identity !== null && document.visibilityState === 'visible',
    qr: async value => {
      const { createMobileGuideQr } = await import('./mobile-guide-qr');
      return createMobileGuideQr(value);
    },
    show: value => api.window.showAnnouncement(value),
  });
  const commandId = 'tencentoa.identity.mobile-guide.open';
  // Keep manual access without adding a redundant destination to the sidebar.
  api.commands.register({ id: commandId, title: 'Open on phone' }, () => guide.show());
  // Open only from the explicit command; first-use reminders are disabled.
}
