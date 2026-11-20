import type { PanelTabDescriptor } from './model';

/** Read-only presentation data. Providers must never create or resume resources. */
export interface PanelPreviewMessage { readonly role: 'user' | 'assistant'; readonly text: string }
export type PanelPreview = { readonly kind: 'conversation'; readonly messages: readonly PanelPreviewMessage[] } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'image'; readonly src: string; readonly iconSrc?: string } | { readonly kind: 'placeholder'; readonly iconSrc?: string };
export type PanelPreviewProvider = (tab: PanelTabDescriptor, ownerId: string, signal: AbortSignal) => Promise<PanelPreview | null> | PanelPreview | null;
interface Entry { value: PanelPreview | null; at: number; provider: PanelPreviewProvider; controller?: AbortController; stale?: boolean }

/** One owner-scoped, memory-only, bounded cache. No tab or resource ownership. */
export class PanelPreviewCache {
  private entries = new Map<string, Entry>();
  private queue: (() => void)[] = [];
  private running = 0;
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(readonly ownerId: string, private readonly limit = 32, private readonly concurrency = 2) {}
  private key(tab: PanelTabDescriptor) { return JSON.stringify([tab.id, tab.kind, tab.resource]); }
  has(tab: PanelTabDescriptor) { const entry = this.entries.get(this.key(tab)); return !!entry && !entry.stale; }
  get(tab: PanelTabDescriptor) { return this.entries.get(this.key(tab))?.value ?? null; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  retain(tabs: readonly PanelTabDescriptor[]) {
    const keys = new Set(tabs.map(tab => this.key(tab)));
    for (const [key, entry] of this.entries) if (!keys.has(key)) { entry.controller?.abort(); this.entries.delete(key); }
  }
  invalidate(tab: PanelTabDescriptor) { const key = this.key(tab); this.entries.get(key)?.controller?.abort(); this.entries.delete(key); this.emit(); }
  refresh(tab: PanelTabDescriptor) {
    const entry = this.entries.get(this.key(tab));
    if (entry) { entry.controller?.abort(); entry.controller = undefined; entry.stale = true; }
    this.emit();
  }
  request(tab: PanelTabDescriptor, provider: PanelPreviewProvider) {
    const key = this.key(tab), old = this.entries.get(key);
    if (old?.provider === provider && (old.controller || !old.stale && Date.now() - old.at < 15000)) return;
    old?.controller?.abort();
    const controller = new AbortController(), generation = this.generation;
    const entry: Entry = { value: old?.provider === provider ? old.value : null, at: Date.now(), provider, controller };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.limit) { const first = this.entries.keys().next().value!; this.entries.get(first)?.controller?.abort(); this.entries.delete(first); }
    this.queue.push(() => {
      if (controller.signal.aborted || generation !== this.generation) { this.pump(); return; }
      this.running++;
      void Promise.resolve().then(() => provider(tab, this.ownerId, controller.signal)).then(value => {
        if (controller.signal.aborted || this.entries.get(key) !== entry || generation !== this.generation) return;
        // Only bounded raster data URLs; no arbitrary network requests or SVG execution.
        const iconSrc = value && 'iconSrc' in value && typeof value.iconSrc === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value.iconSrc) && value.iconSrc.length < 24000 ? value.iconSrc : undefined;
        entry.value = value?.kind === 'conversation' ? { kind: 'conversation', messages: value.messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2).map(m => ({role:m.role,text:m.text.slice(0,600)})) }
          : value?.kind === 'text' ? { kind: 'text', text: value.text.slice(0, 1800) }
          : value?.kind === 'image' && /^data:image\/(png|jpeg|webp);base64,/.test(value.src) && value.src.length < 360000 ? { kind: 'image', src: value.src, iconSrc } : value?.kind === 'placeholder' ? { kind: 'placeholder', iconSrc } : null;
      }).catch(() => {}).finally(() => {
        entry.controller = undefined; entry.at = Date.now(); this.running--; this.emit(); this.pump();
      });
    });
    this.pump();
  }
  private pump() { while (this.running < this.concurrency && this.queue.length) this.queue.shift()!(); }
  clear() { this.generation++; for (const entry of this.entries.values()) entry.controller?.abort(); this.entries.clear(); this.queue = []; this.emit(); }
}
