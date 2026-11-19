import type { AnnouncementContribution, AnnouncementResult } from '@opencraft/extension-contract';

/** Presentation preference only. Browser/site scoped, intentionally independent of accounts. */
export const MOBILE_GUIDE_STORAGE_KEY = 'tencentoa.identity.mobile-guide.seen.v1';
export interface GuideStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export function mobileSiteUrl(href: string): string | null {
  try {
    const url = new URL(href);
    // A local desktop address cannot be reached by scanning it on another device.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) return null;
    // Preserve the current workspace and only the routing fields the application reads.
    const routing = new URLSearchParams();
    for (const key of ["hostId", "draftId"]) {
      const value = url.searchParams.get(key);
      if (value) routing.set(key, value);
    }
    return `${url.origin}${url.pathname}${routing.size ? "?" + routing : ""}`;
  } catch { return null; }
}

export function mobileGuideAnnouncement(image: string, url: string): AnnouncementContribution {
  const workspace = new URL(url);
  const titleMessage = { id: 'ioa.mobileGuide.title', defaultMessage: 'Open on your phone' };
  const bodyMessage = { id: 'ioa.mobileGuide.body', defaultMessage: 'Open WeChat and scan to continue in this workspace.' };
  return {
    id: 'tencentoa.identity.mobile-guide', title: titleMessage.defaultMessage, titleMessage,
    preview: { path: workspace.pathname + workspace.search },
    body: bodyMessage.defaultMessage, bodyMessage,
    media: { kind: 'image-url', url: image, alt: url },
  };
}

/** Owns the once-per-browser preference and cancels async work with the plugin. */
export class MobileGuide {
  private seen = false;
  private pending: Promise<void> | null = null;
  constructor(private readonly ports: {
    storage: GuideStorage | null;
    signal: AbortSignal;
    eligible(): boolean;
    url: string;
    currentUrl?(): string | null;
    qr(url: string): Promise<string>;
    show(value: AnnouncementContribution): Promise<AnnouncementResult>;
  }) {}

  show(automatic = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.ports.signal.aborted || !this.ports.eligible() || (automatic && this.hasSeen())) return Promise.resolve();
    const pending = this.open();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = null; }).catch(() => {});
    return pending;
  }
  private hasSeen(): boolean {
    try { return this.seen || this.ports.storage?.getItem(MOBILE_GUIDE_STORAGE_KEY) === '1'; }
    catch { return this.seen; }
  }
  private async open(): Promise<void> {
    const candidate = this.ports.currentUrl ? this.ports.currentUrl() : this.ports.url;
    const url = candidate ? mobileSiteUrl(candidate) : null;
    if (!url) return;
    const image = await this.ports.qr(url);
    if (this.ports.signal.aborted || !this.ports.eligible()) return;
    const result = this.ports.show(mobileGuideAnnouncement(image, url));
    // show() synchronously registers with the shared modal owner; generation
    // failures or disposed owners must not consume the first-use reminder.
    this.seen = true;
    try { this.ports.storage?.setItem(MOBILE_GUIDE_STORAGE_KEY, '1'); } catch { /* Session-only when storage is unavailable. */ }
    const response = await result;
    if (response.kind === 'action' && response.actionId === 'forget') {
      try { this.ports.storage?.removeItem(MOBILE_GUIDE_STORAGE_KEY); } catch { /* Browser may deny storage. */ }
      // Keep it dismissed in this activation; a new visit may show it again.
    }
  }
}
