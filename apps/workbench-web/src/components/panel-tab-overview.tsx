import { usePanelOverviewPresentation } from './panel-overview-presentation';
import { useShellPresentation } from './shell-presentation';
import { useOverviewSceneMotion, type OverviewOrigin } from './overview-scene-motion';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, IconButton, ObjectActionSurface, ObjectTitleButton } from '@opencraft/design-system-web/button';
import { CheckIcon, CloseIcon, ChevronRightIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import { workbenchIconMetrics } from '@opencraft/design-system/tokens';
import type { PanelTabDescriptor, PanelPreviewMessage } from '@opencraft/workbench-panels';
import { usePanelNavigation } from './panel-navigation';
import { RetainedViewPreview, primaryChatViewKey, panelViewKey, useRetainedOverview } from './retained-view-preview';
import { useAsyncNotices } from './async-notices';
import { WorkbenchIcon } from './ui/workbench-icon';
import './panel-tab-overview.scss';

const kinds: Record<string, [string, string]> = { browser: ['panel.kind.browser', 'Web pages'], terminal: ['panel.kind.terminal', 'Terminals'], resource: ['panel.kind.resource', 'Files'], sidechat: ['panel.kind.sidechat', 'Side chats'] };
const creations: Record<string, [string, string]> = { 'opencraft.browser.new-tab': ['panel.createBrowser', 'Web page'], 'opencraft.terminal.new-session': ['panel.createTerminal', 'Terminal'], 'workspace.files.open': ['panel.createFiles', 'Files'], 'sidechat.new': ['panel.createSideChat', 'Side chat'] };

function ConversationPreview({ messages }: { messages: readonly PanelPreviewMessage[] }) {
  return <div className="panel-overview-primary__messages" aria-hidden="true">{messages.map((message, index) =>
    <div key={index} className="panel-overview-primary__message" data-role={message.role}><WorkbenchIcon name={message.role === 'user' ? 'user' : 'sparkles'} purpose="panel" /><p><span>{message.text}</span></p></div>
  )}</div>;
}

function PreviewCard({ tab, onOpen, active }: { tab: PanelTabDescriptor; onOpen(): void; active: boolean }) {
  const navigation = usePanelNavigation()!;
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const selected = useShellPresentation()?.foreground === 'tools' && tab.id === navigation.activeTabId;
  const renderer = navigation.renderers.find(r => r.kind === tab.kind);
  const liveView = renderer?.previewPresentation === 'retained-view' && renderer.residency === 'while-tab-open';
  const provider = liveView ? undefined : renderer?.preview;
  const currentPreview = useSyncExternalStore(navigation.previews.subscribe, () => navigation.previews.get(tab));
  const latestFrame = useRef({ preview: currentPreview, title: tab.title });
  latestFrame.current = { preview: currentPreview, title: tab.title };
  const [frozen, setFrozen] = useState<typeof latestFrame.current | null>(null);
  const preview = frozen ? frozen.preview : currentPreview;
  useLayoutEffect(() => {
    const node = ref.current;
    const lock = (event: Event) => setFrozen((event as CustomEvent<boolean>).detail ? latestFrame.current : null);
    node?.addEventListener('overview-preview-lock', lock);
    return () => node?.removeEventListener('overview-preview-lock', lock);
  }, []);
  useEffect(() => {
    if (!active || !provider || !ref.current) return;
    let visible = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; navigation.previews.refresh(tab); }, 250);
    };
    const stopUpdates = renderer?.subscribePreview?.(tab, changed);
    // Reopening an overview reads the current resource even if no events were observed while closed.
    navigation.previews.refresh(tab);
    const unsubscribe = navigation.previews.subscribe(() => { if (visible && !navigation.previews.has(tab)) navigation.previews.request(tab, provider); });
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) navigation.previews.request(tab, provider);
    });
    observer.observe(ref.current); return () => { observer.disconnect(); unsubscribe?.(); stopUpdates?.(); clearTimeout(refreshTimer); };
  }, [navigation.previews, provider, renderer, tab, active]);
  return <ObjectActionSurface className="panel-overview-card" data-overview-card-layout="scene" onOpen={onOpen} data-active={selected} data-tab-id={tab.id} data-tab-kind={tab.kind}>
    <div className="panel-overview-card__heading">{preview && 'iconSrc' in preview && preview.iconSrc ? <img className="panel-overview-card__favicon" src={preview.iconSrc} alt="" /> : <WorkbenchIcon name={tab.icon ?? tab.kind} purpose="panel" />}<div className="panel-overview-card__title-scroll" data-object-scroll><ObjectTitleButton prominence="preview" aria-current={selected ? 'page' : undefined} onClick={onOpen}>{frozen?.title ?? tab.title}</ObjectTitleButton></div>
      {tab.closable ? <IconButton aria-label={intl.formatMessage({ id: 'browser.mobile.closeTab', defaultMessage: 'Close {title}' }, { title: tab.title })} onClick={() => navigation.close(tab)}><CloseIcon /></IconButton> : null}
    </div>
    <div ref={ref} className="panel-overview-card__preview" data-overview-view={panelViewKey(navigation.ownerId, tab.id)} data-preview-kind={preview?.kind} data-object-scroll aria-hidden="true">
      {liveView ? <RetainedViewPreview viewKey={panelViewKey(navigation.ownerId, tab.id)} active={active} fallback={renderer.previewAnchor === 'end' ? <p className="panel-overview__empty">{intl.formatMessage({ id: 'panel.primaryChatEmpty', defaultMessage: 'Return to the conversation' })}</p> : undefined} /> : preview?.kind === 'conversation' ? <ConversationPreview messages={preview.messages} /> : preview?.kind === 'image' ? <img src={preview.src} alt="" /> : preview?.kind === 'text' ? <pre>{preview.text}</pre> : <div className="panel-overview-card__placeholder"><WorkbenchIcon name={tab.icon ?? tab.kind} purpose="panel" /><span>{tab.title}</span></div>}
    </div>
  </ObjectActionSurface>;
}

export function PanelTabOverview({ onDismiss, onOpen = onDismiss, active = true, origin, registerDismiss }: { onDismiss(): void; onOpen?(): void; active?: boolean; origin?: OverviewOrigin | null; registerDismiss?(dismiss: () => void): () => void }) {
  useRetainedOverview(active);
  const navigation = usePanelNavigation()!;
  const root = useRef<HTMLDivElement>(null);
  const shell = useShellPresentation();
  const overview = usePanelOverviewPresentation();
  const latestNavigation = useRef(navigation); latestNavigation.current = navigation;
  const primaryKey = primaryChatViewKey(navigation.ownerId);
  const home = useRef({ primary: origin?.key === primaryKey || (!origin && shell?.foreground !== 'tools'), tabId: navigation.activeTabId });

  const prepareDismiss = origin && overview ? (signal: AbortSignal) => {
    const tab = latestNavigation.current.tabs.find(tab => tab.id === home.current.tabId);
    if (!home.current.primary && !tab) return null;
    const key = !home.current.primary && tab ? panelViewKey(navigation.ownerId, tab.id) : primaryKey;
    return overview.prepare(navigation.ownerId, key, signal);
  } : undefined;
  const motion = useOverviewSceneMotion({ root, origin, onDismiss, registerDismiss,
    chromeOpacity: origin ? overview?.chromeOpacity : undefined, prepareDismiss,
    finishScene: origin ? overview?.finishScene : undefined,
    destination: key => shell?.sceneBounds?.(key === primaryKey ? 'primary' : 'tools') ?? null,
  });
  const select = (key: string, navigate: () => void) => {
    // The inline empty-tool launcher has no modal handback. Its normal Shell
    // navigation owns the movement; do not also start a card flight there.
    if (!origin || !overview) { navigate(); onOpen(); return; }
    motion.select(key, () => { navigate(); onOpen(); },
      signal => overview.prepare(navigation.ownerId, key, signal));
  };
  const intl = useIntl(), notices = useAsyncNotices();
  const [kind, setKind] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const lifetime = useRef(true);
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  const text = (id: string, defaultMessage: string) => intl.formatMessage({ id, defaultMessage });
  const creationOrder = Object.keys(creations);
  const creationActions = [...navigation.creationActions].sort((a, b) => {
    const rank = (id: string) => { const index = creationOrder.indexOf(id); return index < 0 ? creationOrder.length : index; };
    return rank(a.id) - rank(b.id);
  });
  const availableKinds = [...new Set(navigation.tabs.map(tab => tab.kind))];
  const selectedKind = kind && availableKinds.includes(kind) ? kind : null;
  const tabs = navigation.tabs.filter(tab => !selectedKind || tab.kind === selectedKind);
  const label = (value: string) => {
    const registered = navigation.renderers.find(r => r.kind === value)?.label;
    if (registered) return intl.formatMessage(registered);
    const builtin = kinds[value]; return builtin ? text(...builtin) : text('panel.kind.other', 'Other tools');
  };
  const run = async (action: typeof navigation.creationActions[number]) => {
    if (pending) return; setPending(action.id);
    try { await action.run(); if (lifetime.current) onOpen(); }
    catch { if (lifetime.current) notices.error({ key: 'panel-create:' + action.id, message: text('panel.actionFailed', 'Could not open the preview. Try again.') }); }
    finally { if (lifetime.current) setPending(null); }
  };
  const openChat = () => select(primaryKey, () => latestNavigation.current.openPrimaryChat());
  return <div ref={root} className="panel-overview-layout">
    {(availableKinds.length > 1 && navigation.tabs.length > 6) || selectedKind !== null ? <nav className="panel-overview__filters" aria-label={text('panel.filterKinds', 'Filter tab types')}>
      <Button variant={selectedKind === null ? 'secondary' : 'ghost'} aria-pressed={selectedKind === null} onClick={() => { motion.cancel(); setKind(null); }}>{text('panel.allTabs', 'All')}</Button>
      {availableKinds.map(value => <Button key={value} variant={selectedKind === value ? 'secondary' : 'ghost'} aria-pressed={selectedKind === value} onClick={() => { motion.cancel(); setKind(value); }}>{label(value)}</Button>)}
    </nav> : null}
    <div className="panel-overview__scroll"><div className="panel-overview__grid">
      <ObjectActionSurface className="panel-overview-card panel-overview-primary" data-overview-card-layout="scene" data-active={shell?.foreground === 'primary'} onOpen={openChat}>
        <div className="panel-overview-card__heading"><WorkbenchIcon name="chat" purpose="panel" size={workbenchIconMetrics.overview.heading} /><ObjectTitleButton prominence="preview" aria-current={shell?.foreground === 'primary' ? 'page' : undefined} onClick={openChat}>{text('panel.primaryChat', 'Main chat')}</ObjectTitleButton></div>
        <div className="panel-overview-card__preview" data-overview-view={primaryKey}><RetainedViewPreview viewKey={primaryKey} active={active} fallback={<p className="panel-overview__empty">{text('panel.primaryChatEmpty', 'Return to the conversation')}</p>} /></div>
      </ObjectActionSurface>
      <section className="panel-overview-card panel-overview-create" aria-label={text('panel.newTool', 'New tool')}>
        <div className="panel-overview-card__heading"><WorkbenchIcon name="applications" purpose="panel" size={workbenchIconMetrics.overview.heading} /><h2>{text('panel.newTool', 'New tool')}</h2></div>
        <div className="panel-overview-create__actions">
          {creationActions.map(action => <Button key={action.id} size="navigation" variant="ghost" contentLayout="row" loading={pending === action.id} disabled={pending !== null && pending !== action.id} onClick={() => void run(action)}><WorkbenchIcon name={action.icon} purpose="panel" size={workbenchIconMetrics.overview.action} /><span className="panel-overview-create__label">{creations[action.id] ? text(...creations[action.id]!) : action.label}</span><ChevronRightIcon className="panel-overview-create__chevron" /></Button>)}
          {!navigation.creationActions.length ? <p className="panel-overview__empty">{text('panel.noActions', 'No previews available for this connection.')}</p> : null}
        </div>
      </section>
      {tabs.map(tab => <PreviewCard key={tab.id} tab={tab} active={active} onOpen={() => select(panelViewKey(navigation.ownerId, tab.id), () => { if (latestNavigation.current.tabs.some(current => current.id === tab.id)) latestNavigation.current.activate(tab.id); })} />)}
    </div>{!tabs.length && selectedKind ? <p className="panel-overview__empty">{text('panel.noMatchingTabs', 'No matching tabs')}</p> : null}</div>
    <footer className="panel-overview__footer">
      <span className="panel-overview__dock-spacer" />
      <IconButton size="navigation" surface="floating" variant="primary" aria-label={text('common.done', 'Done')} onClick={motion.dismiss}><CheckIcon /></IconButton>
    </footer>
  </div>;
}
