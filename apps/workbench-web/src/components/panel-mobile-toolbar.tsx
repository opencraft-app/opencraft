import './panel-mobile-toolbar.scss';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SidebarToggleIcon, CloseIcon, MoreIcon, TabCountIcon } from '@opencraft/design-system-web/action-icons';
import { Button, IconButton } from '@opencraft/design-system-web/button';
import { TabGroupToolbar } from './tab-group-toolbar';
import { NavigationList, NavigationGroup, NavigationItem } from '@opencraft/design-system-web/navigation';
import { SettingsTextInput } from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';
import { ModalSurface } from './modal/modal-surface';
import { SafeLayout } from '@opencraft/design-system-web/safe-layout';
import { usePanelNavigation } from './panel-navigation';
import { useShellPresentation } from './shell-presentation';
import { FloatingComposerToggle, useFloatingComposerControls } from './thread-composer-presentation';
import { WorkbenchIcon } from './ui/workbench-icon';

type RunOperation = (operation: () => void | Promise<unknown>) => void;

/** All tab types consume the same panel navigation and return destination. */
export function PanelMobileToolbar({ panelTabId, children, actions, editing = false, moreLabel, renderMore }: {
  panelTabId: string;
  children?: ReactNode;
  actions?: ReactNode;
  editing?: boolean;
  moreLabel?: string;
  renderMore?: (run: RunOperation, dismiss: () => void) => ReactNode;
}) {
  const intl = useIntl();
  const navigation = usePanelNavigation();
  const shell = useShellPresentation();
  const { store } = useFloatingComposerControls(panelTabId);
  const [sheet, setSheet] = useState<'tabs' | 'more' | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const text = (descriptor: { id: string; defaultMessage: string }) => intl.formatMessage(descriptor);
  const hideAgent = () => { if (panelTabId) store.hide(panelTabId, true); store.focus(null); };
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
    <TabGroupToolbar label={text({ id: 'panel.tabs', defaultMessage: 'Tabs' })} editing={editing}
      leading={<IconButton type="button" className="panel-mobile-dock__button" aria-label={text({ id: 'browser.mobile.workspace', defaultMessage: 'Back to workspace' })}
        onClick={() => { hideAgent(); shell?.toggleRightPanel(); }}><SidebarToggleIcon sidebarOpen={false} /></IconButton>}
      content={children ?? <span className="panel-mobile-dock__title">{navigation?.tabs.find(tab => tab.id === navigation.activeTabId)?.title}</span>}
      contextualActions={<>
        <FloatingComposerToggle activeTabId={panelTabId} touchChrome />
        {actions}
        {renderMore ? <IconButton type="button" className="panel-mobile-dock__button" aria-label={moreLabel!}
          aria-haspopup="dialog" onClick={() => openSheet('more')}><MoreIcon /></IconButton> : null}
      </>}
      tabSwitcher={navigation ? <IconButton type="button" className="panel-mobile-dock__button panel-mobile-dock__tabs"
        aria-label={text({ id: 'panel.tabs', defaultMessage: 'Tabs' })} aria-haspopup="dialog" onClick={() => openSheet('tabs')}>
        <TabCountIcon count={navigation.tabs.length} />
      </IconButton> : null}
    />
    {sheet ? <ModalSurface label={sheet === 'tabs' ? text({ id: 'panel.tabs', defaultMessage: 'Tabs' }) : moreLabel!}
      className={`panel-mobile-sheet panel-mobile-sheet--${sheet}`} presentation={sheet === 'tabs' ? 'fullscreen' : 'adaptive-sheet'}
      showCloseButton={false} onDismiss={() => setSheet(null)}>
      <SafeLayout className="panel-mobile-sheet__body" edges={['top', 'right', 'bottom', 'left']}
        minimumInsets={{ top: 'calc(var(--spacing) * 5)', right: 'calc(var(--spacing) * 5)', bottom: 'calc(var(--spacing) * 5)', left: 'calc(var(--spacing) * 5)' }}>
      <header className="panel-mobile-sheet__header"><h2>{sheet === 'tabs' ? text({ id: 'panel.tabs', defaultMessage: 'Tabs' }) : moreLabel!}</h2>
        <Button variant="ghost" onClick={() => setSheet(null)}>{text({ id: 'common.done', defaultMessage: 'Done' })}</Button>
      </header>
      {sheet === 'tabs' ? <>
        <SettingsTextInput type="search" className="panel-mobile-sheet__search" aria-label={text({ id: 'browser.mobile.searchTabs', defaultMessage: 'Search tabs' })}
          placeholder={text({ id: 'browser.mobile.searchTabs', defaultMessage: 'Search tabs' })} value={filter} onChange={event => setFilter(event.target.value)} />
        <NavigationList className="panel-mobile-sheet__tabs" label={text({ id: 'panel.openTabs', defaultMessage: 'Open tabs' })}>
          <NavigationGroup>
          {tabs.map(item => <article key={item.id} className="panel-mobile-tab" data-tab-id={item.id} data-tab-kind={item.kind} data-active={item.id === navigation?.activeTabId}>
            <NavigationItem className="panel-mobile-tab__activate" aria-current={item.id === navigation?.activeTabId ? 'page' : undefined}
              onClick={() => { navigation?.activate(item.id); setSheet(null); }}>
              <WorkbenchIcon name={item.icon ?? item.kind} purpose="panel" />
              <span className="panel-mobile-tab__title">{item.title}</span>
            </NavigationItem>
            {item.closable ? <IconButton className="panel-mobile-tab__close" aria-label={intl.formatMessage({ id: 'browser.mobile.closeTab', defaultMessage: 'Close {title}' }, { title: item.title })}
              onClick={() => navigation?.close(item)}><CloseIcon /></IconButton> : null}
          </article>)}
          </NavigationGroup>
          <NavigationGroup>
          {navigation?.creationActions.map(action => <Button key={action.id} variant="ghost" size="navigation" contentLayout="row" className="panel-mobile-tab--new" onClick={() => run(action.run)}>
            <WorkbenchIcon name={action.icon} purpose="panel" /><span>{action.label}</span>
          </Button>)}
          </NavigationGroup>
        </NavigationList>
      </> : renderMore?.(run, () => setSheet(null))}
      {error ? <p role="alert">{error}</p> : null}
      </SafeLayout>
    </ModalSurface> : null}
  </>;
}
