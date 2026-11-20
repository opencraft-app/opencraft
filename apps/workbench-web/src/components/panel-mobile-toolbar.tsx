import { usePanelComposerChrome } from './panel-composer-chrome';
import { PanelOverviewButton, usePanelOverviewPresentation } from './panel-overview-presentation';
import './panel-mobile-toolbar.scss';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SidebarToggleIcon, MoreIcon } from '@opencraft/design-system-web/action-icons';
import { Button, IconButton } from '@opencraft/design-system-web/button';
import { TabGroupToolbar } from './tab-group-toolbar';
import { useIntl } from '@opencraft/i18n/react';
import { ModalSurface } from './modal/modal-surface';
import { SafeLayout } from '@opencraft/design-system-web/safe-layout';
import { usePanelNavigation } from './panel-navigation';
import { useShellPresentation } from './shell-presentation';
import { FloatingComposerToggle, useFloatingComposerControls } from './thread-composer-presentation';

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
  const overview = usePanelOverviewPresentation();
  const chrome = usePanelComposerChrome();
  const headerHost = chrome?.slot?.tabId === panelTabId ? chrome.slot.header : null;
  const { store } = useFloatingComposerControls(panelTabId);
  const [sheet, setSheet] = useState<'more' | null>(null);
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
  const openSheet = (next: 'more') => { if (!headerHost) hideAgent(); setError(null); setSheet(next); };
  return <>
    <TabGroupToolbar label={text({ id: 'panel.tabs', defaultMessage: 'Tabs' })} editing={editing} headerHost={headerHost} transition={headerHost ? chrome?.slot?.transition : undefined} switcherHost={headerHost ? chrome?.slot?.switcher : null}
      leading={<IconButton type="button" className="panel-mobile-dock__button" data-app-shell-sidebar-trigger="true" aria-expanded={shell?.sidebarOpen ?? false} aria-label={text(shell?.sidebarOpen ? { id: 'navigation.hideSidebar', defaultMessage: 'Hide sidebar' } : { id: 'navigation.showSidebar', defaultMessage: 'Show sidebar' })}
        onClick={() => shell?.toggleSidebar()}><SidebarToggleIcon sidebarOpen={shell?.sidebarOpen ?? false} /></IconButton>}
      content={children ?? <span className="panel-mobile-dock__title">{navigation?.tabs.find(tab => tab.id === navigation.activeTabId)?.title}</span>}
      contextualActions={<>
        <FloatingComposerToggle activeTabId={panelTabId} touchChrome />
        {actions}
        {renderMore ? <IconButton type="button" className="panel-mobile-dock__button" aria-label={moreLabel!}
          aria-haspopup="dialog" onClick={() => openSheet('more')}><MoreIcon /></IconButton> : null}
      </>}
      tabSwitcher={navigation && (headerHost || !overview?.composerVisible) ? <PanelOverviewButton /> : null}
    />
    {sheet ? <ModalSurface label={moreLabel!}
      className={`panel-mobile-sheet panel-mobile-sheet--${sheet}`} presentation="adaptive-sheet"
      showCloseButton={false} onDismiss={() => setSheet(null)}>
      <SafeLayout className="panel-mobile-sheet__body" edges={['top', 'right', 'bottom', 'left']}
        minimumInsets={{ top: 'calc(var(--spacing) * 5)', right: 'calc(var(--spacing) * 5)', bottom: 'calc(var(--spacing) * 5)', left: 'calc(var(--spacing) * 5)' }}>
      <header className="panel-mobile-sheet__header"><h2>{moreLabel!}</h2>
        <Button variant="ghost" onClick={() => setSheet(null)}>{text({ id: 'common.done', defaultMessage: 'Done' })}</Button>
      </header>
      {renderMore?.(run, () => setSheet(null))}
      {error ? <p role="alert">{error}</p> : null}
      </SafeLayout>
    </ModalSurface> : null}
  </>;
}
