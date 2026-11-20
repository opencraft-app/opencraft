import { useReducedMotion, useMotionValue, type MotionValue } from 'motion/react';
import { flushSync } from 'react-dom';
import { SceneTransitionOwner, type SceneTransition } from './scene-transition';
import { primaryChatViewKey } from './retained-view-preview';
import type { OverviewOrigin } from './overview-scene-motion';
import { useShellPresentation } from './shell-presentation';
import { createContext, useCallback, useContext, useMemo, useState, useRef, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { IconButton } from '@opencraft/design-system-web/button';
import { TabCountIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';

interface Destination { token: symbol; ownerId: string; tabs: { subscribe(listener: () => void): () => void; getCount(): number }; activeViewKey: string | null }
interface OverviewPresentation {
  chromeOpacity: MotionValue<number>;
  destination: Destination | null;
  open: boolean;
  origin: OverviewOrigin | null;
  composerVisible: boolean;
  presentComposer(token: symbol, visible: boolean): void;
  publish(destination: Destination): void;
  release(token: symbol): void;
  show(origin: OverviewOrigin): void;
  dismiss(): void;
  finishScene(commit: () => void, playback: { stop(): void }): void;
  returnFocus(resolve: () => HTMLElement | null): void;
  preparedScene: SceneTransition | null;
  prepare(ownerId: string, key: string, signal: AbortSignal): SceneTransition;
}
const Context = createContext<OverviewPresentation | null>(null);

/** Shell owns one navigation transaction; the panel still owns its tabs. */
export function PanelOverviewPresentationProvider({ children, scope }: { children: ReactNode; scope: string }) {
  const chromeOpacity = useMotionValue(1);
  const reduced = useReducedMotion();
  const reducedPreference = useRef(reduced);
  reducedPreference.current = reduced;
  const reveal = useRef<{ stop(): void } | null>(null);
  const committing = useRef(false);
  const focusReturn = useRef<(() => HTMLElement | null) | null>(null);
  const focusFrame = useRef<number | null>(null);
  const focusScope = useRef(scope); focusScope.current = scope;
  const returnFocus = useCallback((resolve: () => HTMLElement | null) => {
    if (focusScope.current !== scope) return;
    focusReturn.current = resolve;
    const restore = () => {
      focusFrame.current = null;
      if (chromeOpacity.get() < 1) return;
      const resolveTarget = focusReturn.current;
      focusReturn.current = null;
      const target = resolveTarget?.();
      if (target?.isConnected && !target.closest('[inert], [aria-hidden="true"]')) target.focus({ preventScroll:true });
    };
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(restore);
  }, [chromeOpacity, scope]);
  useLayoutEffect(() => {
    const stop = chromeOpacity.on('change', value => { if (value >= 1 && focusReturn.current) returnFocus(focusReturn.current); });
    // Later user intent wins over a pending restoration. Do not reopen an IME
    // or steal focus from a control chosen during the presentation handoff.
    const cancel = () => { focusReturn.current = null; };
    const focus = (event: FocusEvent) => { if (event.target !== document.body) cancel(); };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', focus, true);
    return () => {
      stop(); cancel(); if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', focus, true);
    };
  }, [chromeOpacity, returnFocus, scope]);
  const finishScene = useCallback((commit: () => void, playback: { stop(): void }) => {
    reveal.current?.stop();
    committing.current = true;
    try { commit(); } finally { committing.current = false; }
    // Transfer the existing driver across modal unmount. Never start a second
    // spring: controls consume the remaining progress of this same gesture.
    reveal.current = playback;
    if (reducedPreference.current) { playback.stop(); chromeOpacity.set(1); }
  }, [chromeOpacity]);
  useLayoutEffect(() => () => reveal.current?.stop(), []);
  const [preparedScene, setPreparedScene] = useState<SceneTransition | null>(null);
  const [transitions] = useState(() => new SceneTransitionOwner(setPreparedScene));
  const [destination, setDestination] = useState<Destination | null>(null);
  const currentDestination = useRef(destination);
  const [composer, setComposer] = useState<symbol | null>(null);
  const presentComposer = useCallback((token: symbol, visible: boolean) => setComposer(previous => visible ? token : previous === token ? null : previous), []);
  useLayoutEffect(() => { transitions.cancel(); setRequest(null); }, [scope, transitions]);
  const [origin, setOrigin] = useState<OverviewOrigin | null>(null);
  const prepare = useCallback((ownerId: string, key: string, signal: AbortSignal) => {
    const owner = currentDestination.current;
    const ownerScope = focusScope.current;
    const foreground = key === primaryChatViewKey(ownerId) ? 'primary' : 'tools';
    let scene!: SceneTransition;
    flushSync(() => { scene = transitions.begin({ ownerId, key, foreground }, signal,
      () => owner?.ownerId === ownerId && currentDestination.current?.token === owner.token && focusScope.current === ownerScope); });
    return scene;
  }, [transitions]);
  useLayoutEffect(() => () => transitions.cancel(), [transitions]);
  const [request, setRequest] = useState<symbol | null>(null);
  useLayoutEffect(() => { if (reduced) { reveal.current?.stop(); chromeOpacity.set(request ? 0 : 1); } }, [reduced, request, chromeOpacity]);
  const chromeOwner = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    const owner = destination?.token ?? null;
    const changedOwner = chromeOwner.current !== owner;
    chromeOwner.current = owner;
    // Release + publish can be batched: ownership may change without ever
    // rendering a null destination. Never carry hidden chrome to the new owner.
    if (changedOwner || !destination) {
      transitions.cancel();
      reveal.current?.stop();
      chromeOpacity.set(destination && request === destination.token ? 0 : 1);
    }
  }, [destination, request, chromeOpacity, transitions]);
  const publish = useCallback((next: Destination) => {
    currentDestination.current = next;
    setDestination(previous => previous?.token === next.token && previous.ownerId === next.ownerId && previous.tabs === next.tabs && previous.activeViewKey === next.activeViewKey ? previous : next);
  }, []);
  const release = useCallback((token: symbol) => {
    if (currentDestination.current?.token === token) { currentDestination.current = null; transitions.cancel(); }
    setDestination(previous => previous?.token === token ? null : previous);
    setRequest(previous => previous === token ? null : previous);
  }, [transitions]);
  const dismiss = useCallback(() => {
    transitions.cancel();
    setRequest(null);
    if (!committing.current) { reveal.current?.stop(); chromeOpacity.set(1); }
  }, [chromeOpacity, transitions]);
  const show = useCallback((origin: OverviewOrigin) => {
    if (!destination) return;
    transitions.cancel();
    focusReturn.current = null;
    reveal.current?.stop();
    // Navigation never preserves an editor's IME as the modal return target.
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, [contenteditable=true]')) document.activeElement.blur();
    setOrigin(origin);
    setRequest(destination.token);
  }, [destination, transitions]);
  const value = useMemo(() => ({ chromeOpacity, finishScene, returnFocus, destination, origin, preparedScene, prepare, composerVisible: composer !== null, presentComposer, open: !!destination && request === destination.token, publish, release, show, dismiss }), [chromeOpacity, finishScene, returnFocus, destination, origin, preparedScene, prepare, request, publish, release, show, dismiss, composer, presentComposer]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const usePanelOverviewPresentation = () => useContext(Context);

export function PanelOverviewButton({ composer = false, placement = 'dock', foreground = composer ? 'primary' : 'tools' }: { composer?: boolean; placement?: 'dock' | 'toolbar'; foreground?: 'primary' | 'tools' }) {
  const overview = usePanelOverviewPresentation();
  const intl = useIntl();
  const shell = useShellPresentation();
  if (!overview?.destination) return null;
  const label = intl.formatMessage({ id: 'panel.tabs', defaultMessage: 'Tabs' });
  return <IconButton type="button" size={placement === 'toolbar' ? 'chrome' : 'navigation'} surface={placement === 'toolbar' ? 'integrated' : 'floating'}
    className={placement === 'toolbar' ? 'panel-toolbar-overview' : composer ? 'opencraft-composer-panel-toggle' : 'panel-mobile-dock__button panel-mobile-dock__tabs'}
    data-testid={composer ? 'composer-panel-toggle' : undefined}
    aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={overview.open}
    onClick={() => {
      const destination = overview.destination;
      if (!destination) return;
      const primaryKey = primaryChatViewKey(destination.ownerId);
      const key = foreground === 'primary' ? primaryKey : destination.activeViewKey ?? JSON.stringify(['tools', destination.ownerId]);
      const rect = shell?.sceneBounds?.(foreground) ?? null;
      shell?.dismissTransientSidebar?.(); overview.show({ key, rect });
    }}><SubscribedTabCount tabs={overview.destination.tabs} /></IconButton>;
}

function SubscribedTabCount({ tabs }: { tabs: Destination["tabs"] }) {
  const count = useSyncExternalStore(tabs.subscribe, tabs.getCount, tabs.getCount);
  return <TabCountIcon count={count} />;
}
