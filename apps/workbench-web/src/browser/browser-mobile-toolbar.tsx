import { useRef, type FormEvent } from 'react';
import type { BrowserPageSnapshot, BrowserTabSnapshot } from '@opencraft/browser-core';
import { ChevronLeftIcon, CloseIcon, ExternalLinkIcon, RefreshIcon } from '@opencraft/design-system-web/action-icons';
import { Button } from '@opencraft/design-system-web/button';
import { useIntl } from '@opencraft/i18n/react';
import { PanelMobileToolbar } from '../components/panel-mobile-toolbar';
import { useFloatingComposerControls } from '../components/thread-composer-presentation';
import { BrowserControlButton } from './browser-control-button';
import { BrowserKeyboardButton } from './browser-keyboard-button';
import { BrowserResourcesButton } from './browser-resources-button';
import { useOptionalBrowserRuntime, useWebBrowserPageRuntime, useBrowserWorkbench } from './browser-runtime-context';

function domain(url: string | null) {
  try { return url ? new URL(url).host.replace(/^www\./, '') : ''; } catch { return url ?? ''; }
}

/** Browser-specific slots inside the shared touch panel chrome. */
export function BrowserMobileToolbar({ page, tab, panelTabId, address, setAddress, editing, setEditing, submit, toggleDevice }: {
  page: BrowserPageSnapshot; tab: BrowserTabSnapshot; panelTabId: string;
  address: string; setAddress(value: string): void;
  editing: boolean; setEditing(value: boolean): void;
  submit(event: FormEvent): boolean;
  toggleDevice(): void;
}) {
  const intl = useIntl();
  const runtime = useOptionalBrowserRuntime();
  const pages = useWebBrowserPageRuntime();
  const workbench = useBrowserWorkbench();
  const { store } = useFloatingComposerControls(panelTabId);
  const input = useRef<HTMLInputElement>(null);
  const text = (descriptor: { id: string; defaultMessage: string }) => intl.formatMessage(descriptor);
  const hideAgent = () => { store.hide(panelTabId, true); store.focus(null); };
  return <PanelMobileToolbar panelTabId={panelTabId} editing={editing}
    actions={<BrowserKeyboardButton touchChrome surfaces={runtime?.surfaces} pageId={page.id} beforeShow={hideAgent} />}
    moreLabel={text({ id: 'browser.mobile.more', defaultMessage: 'More browser actions' })}
    renderMore={(run, dismiss) => <div className="panel-mobile-sheet__utilities">
        <Button variant="secondary" contentLayout="row" disabled={!page.navigation.canGoBack} onClick={() => run(() => pages.goBack(page.id))}><ChevronLeftIcon />{text({ id: 'navigation.back', defaultMessage: 'Back' })}</Button>
        <Button variant="secondary" contentLayout="row" onClick={() => run(() => page.navigation.isLoading ? pages.stop(page.id) : pages.reload(page.id))}>
          {page.navigation.isLoading ? <CloseIcon /> : <RefreshIcon />}
          {text(page.navigation.isLoading ? { id: 'browser.stop', defaultMessage: 'Stop' } : { id: 'browser.reload', defaultMessage: 'Reload' })}
        </Button>
        <BrowserControlButton surfaces={runtime?.surfaces} pageId={page.id} showLabel />
        <BrowserResourcesButton surfaces={runtime?.surfaces} workbench={workbench} ownerId={tab.ownerId} showLabel />
        <Button variant="secondary" contentLayout="row" disabled={!page.navigation.canGoForward} onClick={() => run(() => { pages.goForward(page.id); })}>{text({ id: 'navigation.forward', defaultMessage: 'Forward' })}</Button>
        <Button variant="secondary" contentLayout="row" onClick={() => { toggleDevice(); dismiss(); }}>{text({ id: 'browser.device', defaultMessage: 'Toggle device toolbar' })}</Button>
        <Button variant="secondary" contentLayout="row" disabled={!page.navigation.currentUrl} onClick={() => {
          if (page.navigation.currentUrl) window.open(page.navigation.currentUrl, '_blank', 'noopener,noreferrer');
        }}><ExternalLinkIcon />{text({ id: 'browser.external', defaultMessage: 'Open in external browser' })}</Button>
        {pages.supportsSiteSettings && page.navigation.currentUrl ? <>
          <Button variant="secondary" contentLayout="row" onClick={() => run(() => pages.siteSettings(page.id, 'permissions'))}>{text({ id: 'browser.permissions', defaultMessage: 'Site permissions' })}</Button>
          <Button variant="secondary" contentLayout="row" onClick={() => run(() => pages.siteSettings(page.id, 'clear-data'))}>{text({ id: 'browser.clearData', defaultMessage: 'Clear site data' })}</Button>
          <Button variant="secondary" contentLayout="row" onClick={() => run(() => pages.clearClosedData())}>{text({ id: 'browser.clearClosed', defaultMessage: 'Clear closed tab data' })}</Button>
        </> : null}
    </div>}>
    <form className="panel-mobile-dock__location" aria-label={text({ id: 'browser.mobile.navigation', defaultMessage: 'Browser controls' })} onSubmit={event => {
      if (submit(event)) input.current?.blur();
    }}>
      <input ref={input} aria-label={text({ id: 'browser.address', defaultMessage: 'Web address' })} autoCapitalize="none" autoCorrect="off"
        spellCheck={false} inputMode="url" enterKeyHint="go" value={editing ? address : domain(page.navigation.currentUrl)}
        placeholder={text({ id: 'browser.address.placeholder', defaultMessage: 'Enter a web address' })}
        onFocus={event => { hideAgent(); setEditing(true); event.currentTarget.value = address; event.currentTarget.select(); }}
        onBlur={() => setEditing(false)} onChange={event => setAddress(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); input.current?.blur(); } }} />
    </form>
  </PanelMobileToolbar>;
}

export default BrowserMobileToolbar;
