'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentsExpoWebApplication, AgentsExpoWebOptions } from '@opencraft/mobile-bot-bridge';
import { useSession } from '@/contexts/session-context';
import { useCurrentLocale } from '@/i18n/t';
import { isGlobal } from '@/lib/region';
import { readStoredAuthToken } from '@/repositories/http-repositories';
import { Button } from '@/components/ui/button';
import { AppRouteShell } from './app-route-shell';

let resource: Promise<AgentsExpoWebApplication> | null = null;
let styleUrls: string[] = [];
async function installStyles() {
  await Promise.all(styleUrls.map(href => new Promise<void>((resolve, reject) => {
    if (document.querySelector(`link[data-expo-agents][href="${href}"]`)) { resolve(); return; }
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = href; style.dataset.expoAgents = '1';
    style.onload = () => resolve(); style.onerror = () => { style.remove(); reject(new Error('surface.unavailable')); };
    document.head.append(style);
  })));
}
function loadExpoSurface(): Promise<AgentsExpoWebApplication> {
  const existing = (window as Window & { __OPENCRAFT_EXPO_AGENTS__?: AgentsExpoWebApplication }).__OPENCRAFT_EXPO_AGENTS__;
  if (existing) return installStyles().then(() => existing);
  if (resource) return resource;
  resource = fetch('/__expo-agents/manifest.json').then(async response => {
    if (!response.ok) throw new Error('surface.unavailable');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') throw new Error('surface.invalid');
    const manifest = value as { version?: unknown; scripts?: unknown; styles?: unknown };
    const safeAssets = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 8 && items.every(item => typeof item === 'string' && item.startsWith('/__expo-agents/') && !item.includes('..'));
    if (manifest.version !== 1 || !safeAssets(manifest.scripts) || !safeAssets(manifest.styles)) throw new Error('surface.invalid');
    styleUrls = [...new Set(manifest.styles)];
    await installStyles();
    for (const src of manifest.scripts) await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = src; script.defer = true;
      script.onload = () => resolve(); script.onerror = () => { script.remove(); reject(new Error('surface.unavailable')); };
      document.head.append(script);
    });
    const application = (window as Window & { __OPENCRAFT_EXPO_AGENTS__?: AgentsExpoWebApplication }).__OPENCRAFT_EXPO_AGENTS__;
    if (!application) throw new Error('surface.unavailable');
    return application;
  }).catch(error => { resource = null; throw error; });
  return resource;
}
function ExpoSurface() {
  const { session, signOut } = useSession();
  const locale = useCurrentLocale();
  const router = useRouter();
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<AgentsExpoWebApplication["mount"]> | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const zh = locale.startsWith('zh');
  const token = readStoredAuthToken();
  const options = useMemo<AgentsExpoWebOptions>(() => ({
    runtimeHtmlUrl: '/__expo-agents/bot-runtime.html', region: isGlobal ? 'intl' : 'cn', language: zh ? 'zh-CN' : 'en', token: token ?? '',
    account: { displayName: session?.user.name ?? null, avatarUrl: session?.user.avatarUrl ?? null },
    onExternalNavigation(href) {
      const url = new URL(href, window.location.origin);
      if (!['https:', 'http:'].includes(url.protocol)) return;
      if ([window.location.host, 'lightvela.ai', 'lightvela.com'].includes(url.host)) router.push(url.pathname + url.search + url.hash);
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    onOpenAccount: () => router.push('/account'), onSignedOut: () => { void signOut(); },
    onDiagnostic: event => window.dispatchEvent(new CustomEvent('opencraft-agents-diagnostic', { detail: event })),
  }), [session?.user.name, session?.user.avatarUrl, token, zh, router, signOut]);
  const latestOptions = useRef(options); latestOptions.current = options;
  useEffect(() => { instance.current?.update(options); }, [options]);
  useEffect(() => {
    let live = true;
    setFailed(false);
    if (!options.token) { setFailed(true); return; }
    void loadExpoSurface().then(application => { if (live && element.current) instance.current = application.mount(element.current, latestOptions.current); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; instance.current?.dispose(); instance.current = null; document.querySelectorAll("link[data-expo-agents]").forEach(link => link.remove()); };
  }, [options.token, retry]);
  return <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--background)' }}>
    <div ref={element} style={{ height: '100%', width: '100%', display: 'flex' }} />
    {failed ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-4"><p>{zh ? '暂时无法打开' : 'Could not open'}</p><Button onClick={() => setRetry(value => value + 1)}>{zh ? '重新加载' : 'Reload'}</Button></div> : null}
  </main>;
}
export function AgentsNextPageClient() {
  return <AppRouteShell showAuthGateFooter={false}><ExpoSurface /></AppRouteShell>;
}
