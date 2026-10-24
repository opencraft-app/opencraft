import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserPageSnapshot, BrowserTabSnapshot } from '@opencraft/browser-core';
import { AddIcon, ChevronLeftIcon, CloseIcon, ExternalLinkIcon, GlobeIcon, MoreIcon, RefreshIcon, SidebarLayoutIcon, SquareIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import { ModalSurface } from '../components/modal/modal-surface';
import { SafeLayout } from '@opencraft/design-system-web/safe-layout';
import { usePanelNavigation } from '../components/panel-navigation';
import { useShellPresentation } from '../components/shell-presentation';
import { FloatingComposerToggle, useFloatingComposerControls } from '../components/thread-composer-presentation';
import { WorkbenchIcon } from '../components/ui/workbench-icon';
import { BrowserControlButton } from './browser-control-button';
import { BrowserKeyboardButton } from './browser-keyboard-button';
import { BrowserResourcesButton } from './browser-resources-button';
import { useOptionalBrowserRuntime, useWebBrowserPageRuntime, useBrowserWorkbench } from './browser-runtime-context';

function domain(url: string | null) {
  try { return url ? new URL(url).host : ''; } catch { return url ?? ''; }
}

/** Mobile chrome consumes the same navigation, resource and editing owners. */
export function BrowserMobileToolbar({ page, tab, panelTabId, address, setAddress, editing, setEditing, submit, toggleDevice }: {
  page: BrowserPageSnapshot; tab: BrowserTabSnapshot; panelTabId: string;
  address: string; setAddress(value: string): void;
  editing: boolean; setEditing(value: boolean): void;
  submit(event: FormEvent): boolean;
  toggleDevice(): void;
}) {
  const intl = useIntl();
  const navigation = usePanelNavigation();
  const shell = useShellPresentation();
  const runtime = useOptionalBrowserRuntime();
  const pages = useWebBrowserPageRuntime();
  const workbench = useBrowserWorkbench();
  const { store } = useFloatingComposerControls(panelTabId);
  const [sheet, setSheet] = useState<'tabs' | 'more' | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const input = useRef<HTMLInputElement>(null);
  const text = (descriptor: { id: string; defaultMessage: string }) => intl.formatMessage(descriptor);
  const hideAgent = () => { store.hide(panelTabId, true); store.focus(null); };
  const run = (operation: () => void | Promise<unknown>) => {
    setError(null);
    try {
      void Promise.resolve(operation()).then(() => { if (mounted.current) setSheet(null); })
        .catch(() => { if (mounted.current) setError(text({ id: 'panel.actionFailed', defaultMessage: 'Could not open the preview. Try again.' })); });
    } catch { setError(text({ id: 'panel.actionFailed', defaultMessage: 'Could not open the preview. Try again.' })); }
  };
  const tabs = navigation?.tabs.filter(item => !filter || item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const openSheet = (next: 'tabs' | 'more') => { hideAgent(); setFilter(''); setError(null); setSheet(next); };
  return <>
    <div className="browser-mobile-dock" data-address-editing={editing}>
      <form className="browser-mobile-dock__address" onSubmit={event => {
        if (submit(event)) input.current?.blur();
      }}>
        <button type="button" className="browser-toolbar-button" disabled={!page.navigation.canGoBack}
          aria-label={text({ id: 'navigation.back', defaultMessage: 'Back' })} onClick={() => pages.goBack(page.id)}><ChevronLeftIcon size={23} /></button>
        <label className="browser-mobile-dock__location">
          <GlobeIcon size={15} />
          <input ref={input} aria-label={text({ id: 'browser.address', defaultMessage: 'Web address' })} autoCapitalize="none" autoCorrect="off"
            spellCheck={false} inputMode="url" enterKeyHint="go" value={editing ? address : domain(page.navigation.currentUrl)}
            placeholder={text({ id: 'browser.address.placeholder', defaultMessage: 'Enter a web address' })}
            onFocus={event => { hideAgent(); setEditing(true); event.currentTarget.value = address; event.currentTarget.select(); }}
            onBlur={() => setEditing(false)} onChange={event => setAddress(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); input.current?.blur(); } }} />
        </label>
        <button type="button" className="browser-toolbar-button" aria-label={text(page.navigation.isLoading ? { id: 'browser.stop', defaultMessage: 'Stop' } : { id: 'browser.reload', defaultMessage: 'Reload' })}
          onClick={() => page.navigation.isLoading ? pages.stop(page.id) : pages.reload(page.id)}>
          {page.navigation.isLoading ? <CloseIcon size={21} /> : <RefreshIcon size={21} />}
        </button>
      </form>
      <nav className="browser-mobile-dock__actions" aria-label={text({ id: 'browser.mobile.navigation', defaultMessage: 'Browser controls' })}>
        <button type="button" className="browser-toolbar-button" aria-label={text({ id: 'browser.mobile.workspace', defaultMessage: 'Back to workspace' })}
          onClick={() => { hideAgent(); shell?.toggleRightPanel(); }}><SidebarLayoutIcon size={21} /></button>
        <FloatingComposerToggle activeTabId={panelTabId} label={text({ id: 'browser.agent.title', defaultMessage: 'Agent' })} />
        <BrowserKeyboardButton surfaces={runtime?.surfaces} pageId={page.id} beforeShow={hideAgent} />
        {navigation ? <button type="button" className="browser-toolbar-button browser-mobile-dock__tabs"
          aria-label={text({ id: 'panel.tabs', defaultMessage: 'Tabs' })} aria-haspopup="dialog" onClick={() => openSheet('tabs')}>
          <SquareIcon size={23} /><span>{navigation.tabs.length}</span>
        </button> : null}
        <button type="button" className="browser-toolbar-button" aria-label={text({ id: 'browser.mobile.more', defaultMessage: 'More browser actions' })}
          aria-haspopup="dialog" onClick={() => openSheet('more')}><MoreIcon size={23} /></button>
      </nav>
    </div>
    {sheet ? <ModalSurface label={sheet === 'tabs' ? text({ id: 'panel.tabs', defaultMessage: 'Tabs' }) : text({ id: 'browser.mobile.more', defaultMessage: 'More browser actions' })}
      className={`browser-mobile-sheet browser-mobile-sheet--${sheet}`} presentation={sheet === 'tabs' ? 'fullscreen' : 'adaptive-sheet'}
      showCloseButton={false} onDismiss={() => setSheet(null)}>
      <SafeLayout className="browser-mobile-sheet__body" edges={['top', 'right', 'bottom', 'left']}
        minimumInsets={{ top: 'calc(var(--spacing) * 5)', right: 'calc(var(--spacing) * 5)', bottom: 'calc(var(--spacing) * 5)', left: 'calc(var(--spacing) * 5)' }}>
      <header className="browser-mobile-sheet__header"><h2>{sheet === 'tabs' ? text({ id: 'panel.tabs', defaultMessage: 'Tabs' }) : text({ id: 'browser.mobile.more', defaultMessage: 'More browser actions' })}</h2>
        <button type="button" onClick={() => setSheet(null)}>{text({ id: 'common.done', defaultMessage: 'Done' })}</button>
      </header>
      {sheet === 'tabs' ? <>
        <input className="browser-mobile-sheet__search" aria-label={text({ id: 'browser.mobile.searchTabs', defaultMessage: 'Search tabs' })}
          placeholder={text({ id: 'browser.mobile.searchTabs', defaultMessage: 'Search tabs' })} value={filter} onChange={event => setFilter(event.target.value)} />
        <div className="browser-mobile-sheet__cards">
          {tabs.map(item => <article key={item.id} className="browser-mobile-tab" data-tab-id={item.id} data-active={item.id === navigation?.activeTabId}>
            <button type="button" className="browser-mobile-tab__activate" onClick={() => { navigation?.activate(item.id); setSheet(null); }}>
              <span className="browser-mobile-tab__preview"><WorkbenchIcon name={item.icon ?? item.kind} purpose="panel" /></span>
              <span className="browser-mobile-tab__title">{item.title}</span>
            </button>
            {item.closable ? <button type="button" className="browser-mobile-tab__close" aria-label={intl.formatMessage({ id: 'browser.mobile.closeTab', defaultMessage: 'Close {title}' }, { title: item.title })}
              onClick={() => navigation?.close(item)}><CloseIcon size={18} /></button> : null}
          </article>)}
          {navigation?.createBrowser ? <button type="button" className="browser-mobile-tab browser-mobile-tab--new" onClick={() => run(() => navigation.createBrowser?.())}>
            <AddIcon size={28} /><span>{text({ id: 'panel.newBrowser', defaultMessage: 'New browser tab' })}</span>
          </button> : null}
        </div>
      </> : <div className="browser-mobile-sheet__utilities">
        <BrowserControlButton surfaces={runtime?.surfaces} pageId={page.id} showLabel />
        <BrowserResourcesButton surfaces={runtime?.surfaces} workbench={workbench} ownerId={tab.ownerId} showLabel />
        <button type="button" disabled={!page.navigation.canGoForward} onClick={() => run(() => { pages.goForward(page.id); })}>{text({ id: 'navigation.forward', defaultMessage: 'Forward' })}</button>
        <button type="button" onClick={() => { toggleDevice(); setSheet(null); }}>{text({ id: 'browser.device', defaultMessage: 'Toggle device toolbar' })}</button>
        <button type="button" disabled={!page.navigation.currentUrl} onClick={() => {
          if (page.navigation.currentUrl) window.open(page.navigation.currentUrl, '_blank', 'noopener,noreferrer');
        }}><ExternalLinkIcon size={18} />{text({ id: 'browser.external', defaultMessage: 'Open in external browser' })}</button>
        {pages.supportsSiteSettings && page.navigation.currentUrl ? <>
          <button type="button" onClick={() => run(() => pages.siteSettings(page.id, 'permissions'))}>{text({ id: 'browser.permissions', defaultMessage: 'Site permissions' })}</button>
          <button type="button" onClick={() => run(() => pages.siteSettings(page.id, 'clear-data'))}>{text({ id: 'browser.clearData', defaultMessage: 'Clear site data' })}</button>
          <button type="button" onClick={() => run(() => pages.clearClosedData())}>{text({ id: 'browser.clearClosed', defaultMessage: 'Clear closed tab data' })}</button>
        </> : null}
      </div>}
      {error ? <p role="alert">{error}</p> : null}
      </SafeLayout>
    </ModalSurface> : null}
  </>;
}
