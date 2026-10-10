import type { HostPanelGesture } from "@opencraft/mobile-bot-bridge";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/i18n/react-instance-registration';
import { OpenClawProvider, useOpenClaw } from '@/contexts/agent-context';
import { useRepositories } from '@/contexts/repository-context';
import { RepositoryProvider } from '@/contexts/repository-context';
import { RuntimeConfigProvider } from '@/contexts/runtime-config-context';
import { SessionProvider, useSession } from '@/contexts/session-context';
import {
  AppNavigationProvider,
  targetToHref,
  type AppLinkProps,
  type AppNavigateTarget,
  type AppNavigationValue,
} from '@/lib/app-navigation';
import {
  AGENT_SECTION_PATH_BY_ID,
  getAgentLabSectionFromSlug,
  getAgentSectionFromSlug,
  type AgentSectionId,
  type AgentSettingsSectionId,
} from '@/lib/agent-routes';
import { AgentSettingsPage } from '@/pages/marketing/agent-settings-page';
import { EmbeddedChatPreparation } from '@/lib/opencraft-embedded-connection';
import type { AgentConsoleHostPort } from '@/pages/marketing/agent-console-host';
import { AgentsWorkbenchPage } from '@/pages/marketing/agents-workbench/AgentsWorkbenchPage';
import { useBuddyProfile } from '@/pages/marketing/agent-buddy-profile';
import { BOT_COMMAND_CAPABILITIES, MOBILE_BOT_EVENT, encodeBotBridgeMessage, parseBotCommand, type BotCommand, type BotToHostMessage, type HostPanelState, type HostPanelCommand, type HostPanelGeometry } from '@opencraft/mobile-bot-bridge';

type HostSelection = { readonly section: AgentSectionId; readonly botId: string; readonly search: string };

function siteBase(): string {
  const embedded = (window as Window & { __LIGHTVELA_EMBEDDED_SITE_BASE__?: string }).__LIGHTVELA_EMBEDDED_SITE_BASE__;
  return embedded === 'https://lightvela.com' ? embedded : 'https://lightvela.ai';
}

function runtimeId(): string { return (window as Window & { __LIGHTVELA_BOT_RUNTIME_ID__?: string }).__LIGHTVELA_BOT_RUNTIME_ID__ ?? ''; }

function sendToHost(payload: BotToHostMessage) {
  if (!runtimeId()) return;
  (window as Window & { ReactNativeWebView?: { postMessage(message: string): void } })
    .ReactNativeWebView?.postMessage(encodeBotBridgeMessage(runtimeId(), payload));
}

window.addEventListener('opencraft-mobile-bot-create-state', (event: Event) => {
  const detail = (event as CustomEvent<{ visible: boolean; enabled: boolean }>).detail;
  if (detail) sendToHost({ type: 'bot-create-state', visible: detail.visible, enabled: detail.enabled });
});
window.addEventListener('opencraft-mobile-model-load-failed', (event: Event) => {
  const detail = (event as CustomEvent<{ kind: number }>).detail;
  if (detail && Number.isSafeInteger(detail.kind)) sendToHost({ type: 'bot-model-load-failed', kind: detail.kind });
});
document.addEventListener('opencraft-panels', event => {
  const element = event.target as HTMLElement;
  sendToHost({ type: 'chat-panel-state', instanceId: element.dataset.instanceId ?? '', profileId: element.dataset.profileId ?? '', state: (event as CustomEvent<HostPanelState>).detail });
});
document.addEventListener('opencraft-panel-presentation', event => {
  const detail = (event as CustomEvent<{ ownerId: string; active: boolean }>).detail;
  sendToHost({ type: 'chat-panel-presentation', ...detail });
});
window.addEventListener('opencraft-panel-action-failed', () => sendToHost({ type: 'chat-panel-action-failed' }));
interface PanelWorkbenchElement extends HTMLElement {
  dispatchPanelCommand?(command: HostPanelCommand): boolean;
  setPanelGeometry?(ownerId: string, geometry: HostPanelGeometry): boolean;
  dispatchPanelGesture?(ownerId: string, gesture: HostPanelGesture): boolean;
}

function BotAvatarBridge({ bot }: { bot: { id: string; profileId?: string; name: string; status: string } }) {
  const repositories = useRepositories();
  const { profile, hasBuddyConfig, loading, reload } = useBuddyProfile({
    botId: bot.status === 'running' ? bot.id : undefined,
    profileId: bot.profileId,
    fallbackName: bot.name,
    exec: repositories.bots.execDebugCommand,
  });
  useEffect(() => {
    if (loading || hasBuddyConfig === null) return;
    sendToHost({ type: 'bot-avatar', botId: bot.id, configured: hasBuddyConfig, shapeId: profile.shapeId, color: profile.color });
  }, [bot.id, hasBuddyConfig, loading, profile.shapeId, profile.color]);
  useEffect(() => {
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === bot.id) reload();
    };
    window.addEventListener('opencraft-mobile-bot-profile-changed', onChanged);
    return () => window.removeEventListener('opencraft-mobile-bot-profile-changed', onChanged);
  }, [bot.id, reload]);
  return null;
}

function AgentListBridge() {
  const { bots, botsLoading, botsError, refreshBots } = useOpenClaw();
  const { authReady, isAuthenticated } = useSession();
  useEffect(() => {
    sendToHost({ type: 'bot-auth-state', ready: authReady, authenticated: isAuthenticated });
  }, [authReady, isAuthenticated]);
  useEffect(() => {
    sendToHost({
      type: 'bot-catalog',
      loading: botsLoading,
      error: botsError,
      bots: bots.map(bot => ({
        id: bot.id,
        instanceId: bot.instanceId ?? bot.id,
        profileId: bot.profileId ?? 'main',
        name: bot.name,
        status: bot.status,
        isDefault: bot.isDefault === true,
      })),
    });
  }, [bots, botsLoading, botsError]);
  useEffect(() => {
    const onRefresh = () => { void refreshBots(); };
    window.addEventListener('opencraft-mobile-bot-refresh', onRefresh);
    return () => window.removeEventListener('opencraft-mobile-bot-refresh', onRefresh);
  }, [refreshBots]);
  return <>{bots.map(bot => <BotAvatarBridge key={`${bot.id}:${bot.profileId ?? ''}`} bot={bot} />)}</>;
}

function EmbeddedLink({ to, children, onClick, ...props }: AppLinkProps) {
  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('opencraft-mobile-bot-link', { detail: to }));
  };
  return <a href={to} onClick={handleClick} {...props}>{children}</a>;
}

class EmbeddedSectionBoundary extends Component<{ section: AgentSectionId; children: ReactNode }, { section: AgentSectionId; failed: boolean }> {
  state = { section: this.props.section, failed: false };

  static getDerivedStateFromProps(props: { section: AgentSectionId }, state: { section: AgentSectionId; failed: boolean }) {
    return props.section === state.section ? null : { section: props.section, failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    sendToHost({ type: 'bot-section-render-failed', section: this.props.section });
  }

  render() { return this.state.failed ? null : this.props.children; }
}

function MobileBotRuntime() {
  const listeners = useRef(new Set<(command: BotCommand) => boolean>());
  const consoleHost = useMemo<AgentConsoleHostPort>(() => ({
    publish: sendToHost,
    subscribe(listener) {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
  }), []);
  const [presentationActive, setPresentationActive] = useState(true);
  const [selection, setSelection] = useState<HostSelection>({ section: 'chat', botId: '', search: '' });
  const [createRequestId, setCreateRequestId] = useState(0);
  const [deleteRequest, setDeleteRequest] = useState<{ id: string; serial: number } | null>(null);
  const createSequence = useRef(0);
  const deleteSequence = useRef(0);
  const acknowledgeCreateRequest = useCallback(() => setCreateRequestId(0), []);
  const acknowledgeDeleteRequest = useCallback(() => setDeleteRequest(null), []);

  const navigate = useCallback((target: AppNavigateTarget, options?: { replace?: boolean }) => {
    const href = targetToHref(target);
    const url = new URL(href, siteBase());
    const slug = url.pathname.split('/').filter(Boolean)[1];
    const section = url.pathname === '/agents' ? 'chat'
      : slug === 'labs' ? getAgentLabSectionFromSlug(url.pathname.split('/').filter(Boolean)[2])
        : getAgentSectionFromSlug(slug);
    if (section) {
      const botId = url.searchParams.get('bot')?.trim() ?? selection.botId;
      const nextSection = section === 'overview' ? 'chat' : section;
      setSelection({ section: nextSection, botId, search: url.search });
      sendToHost({ type: 'bot-selection', section: nextSection, botId });
      return;
    }
    sendToHost({ type: 'external-navigation', href: url.href, replace: options?.replace === true });
  }, [selection.botId]);

  useEffect(() => {
    const onSelect = (event: Event) => {
      const detail = (event as CustomEvent<Partial<HostSelection>>).detail;
      if (!detail || typeof detail.section !== 'string') return;
      if (!Object.prototype.hasOwnProperty.call(AGENT_SECTION_PATH_BY_ID, detail.section)) return;
      const botId = typeof detail.botId === 'string' ? detail.botId : '';
      setSelection({ section: detail.section === 'overview' ? 'chat' : detail.section as AgentSectionId, botId, search: botId ? `?bot=${encodeURIComponent(botId)}` : '' });
    };
    const onLink = (event: Event) => {
      const href = (event as CustomEvent<unknown>).detail;
      if (typeof href === 'string') navigate(href);
    };
    const onCreate = () => {
      // Creation is a presentation over the current Bot, not a section switch.
      // Keep its Chat controller and draft alive while the form is open.
      setCreateRequestId(++createSequence.current);
    };
    const onDelete = (event: Event) => {
      const botId = (event as CustomEvent<unknown>).detail;
      if (typeof botId !== 'string' || !botId) return;
      setSelection({ section: 'chat', botId, search: `?bot=${encodeURIComponent(botId)}` });
      sendToHost({ type: 'bot-selection', section: 'chat', botId });
      setDeleteRequest({ id: botId, serial: ++deleteSequence.current });
    };
    const onCommand = (event: Event) => {
      const raw = (event as CustomEvent<unknown>).detail;
      const command = typeof raw === 'string' ? parseBotCommand(raw, runtimeId()) : null;
      if (!command) return;
      for (const listener of listeners.current) if (listener(command)) return;
      switch (command.type) {
        case 'chat-panel': document.querySelector<PanelWorkbenchElement>('opencraft-embedded-workbench')?.dispatchPanelCommand?.(command.command); break;
        case 'chat-panel-gesture': document.querySelector<PanelWorkbenchElement>('opencraft-embedded-workbench')?.dispatchPanelGesture?.(command.ownerId, command.gesture); break;
        case 'chat-panel-geometry': document.querySelector<PanelWorkbenchElement>('opencraft-embedded-workbench')?.setPanelGeometry?.(command.ownerId, command.geometry); break;
        case 'visibility': setPresentationActive(command.active); break;
        case 'session': break; // No active controller: fail closed, never queue a mutation.
        case 'select': onSelect(new CustomEvent('select', { detail: command })); break;
        case 'refresh': window.dispatchEvent(new Event('opencraft-mobile-bot-refresh')); break;
        case 'create': onCreate(); break;
        case 'delete': onDelete(new CustomEvent('delete', { detail: command.botId })); break;
        case 'link': onLink(new CustomEvent('link', { detail: command.href })); break;
      }
    };
    window.addEventListener(MOBILE_BOT_EVENT, onCommand);
    window.addEventListener('opencraft-mobile-bot-select', onSelect);
    window.addEventListener('opencraft-mobile-bot-link', onLink);
    window.addEventListener('opencraft-mobile-bot-create', onCreate);
    window.addEventListener('opencraft-mobile-bot-delete', onDelete);
    const onDocumentLink = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.hasAttribute('download') || anchor.getAttribute('target') === '_blank') return;
      event.preventDefault();
      navigate(anchor.href);
    };
    document.addEventListener('click', onDocumentLink, true);
    sendToHost({ type: 'bot-runtime-ready', originMatches: window.location.origin === siteBase(), capabilities: BOT_COMMAND_CAPABILITIES });
    return () => {
      window.removeEventListener(MOBILE_BOT_EVENT, onCommand);
      window.removeEventListener('opencraft-mobile-bot-select', onSelect);
      window.removeEventListener('opencraft-mobile-bot-link', onLink);
      window.removeEventListener('opencraft-mobile-bot-create', onCreate);
      window.removeEventListener('opencraft-mobile-bot-delete', onDelete);
      document.removeEventListener('click', onDocumentLink, true);
    };
  }, [navigate]);

  const pathname = AGENT_SECTION_PATH_BY_ID[selection.section];
  const search = selection.search;
  const navigation = useMemo<AppNavigationValue>(() => ({
    Link: EmbeddedLink,
    navigate,
    pathname,
    search,
    setSearchParams(next, options) {
      navigate(`${pathname}${next.size ? `?${next.toString()}` : ''}`, options);
    },
  }), [navigate, pathname, search]);

  return <AppNavigationProvider value={navigation}>
    <AgentListBridge />
    <EmbeddedChatPreparation active={selection.section === 'chat'}>
    <EmbeddedSectionBoundary section={selection.section}>
      {selection.section === 'workbench'
        ? <AgentsWorkbenchPage />
        : <AgentSettingsPage presentationActive={presentationActive} sectionId={selection.section as AgentSettingsSectionId} showHeader={false} embedded consoleHost={consoleHost} createRequestId={createRequestId} onCreateRequestHandled={acknowledgeCreateRequest} deleteRequestId={deleteRequest?.serial} deleteRequestBotId={deleteRequest?.id} onDeleteRequestHandled={acknowledgeDeleteRequest} />}
    </EmbeddedSectionBoundary>
    </EmbeddedChatPreparation>
  </AppNavigationProvider>;
}

function Providers({ children }: { children: ReactNode }) {
  return <RepositoryProvider>
    <RuntimeConfigProvider>
      <SessionProvider>
        <OpenClawProvider>{children}</OpenClawProvider>
      </SessionProvider>
    </RuntimeConfigProvider>
  </RepositoryProvider>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Providers><MobileBotRuntime /></Providers>);
