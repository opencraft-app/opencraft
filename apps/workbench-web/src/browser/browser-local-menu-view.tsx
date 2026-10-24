import * as DropdownMenu from '@opencraft/design-system-web/dropdown-menu';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import type { BrowserLocalMenuController } from './browser-local-menu';
import '../styles/context-menu.scss';
import './browser-local-menu.scss';

export function BrowserLocalMenu({ controller }: { readonly controller: BrowserLocalMenuController }) {
  const intl = useIntl();
  const menu = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const copy = intl.formatMessage({ id: 'browser.menu.copy', defaultMessage: 'Copy' });
  const copyLink = intl.formatMessage({ id: 'browser.menu.copyLink', defaultMessage: 'Copy link address' });
  useLayoutEffect(() => { controller.setLabels({ copy, copyLink }); }, [controller, copy, copyLink]);
  useLayoutEffect(() => () => controller.retire(), [controller]);
  if (!menu) return null;
  return <DropdownMenu.Root key={menu.id} open modal={false}
    onOpenChange={open => { if (!open) controller.dismiss(menu.id); }}>
    <DropdownMenu.Trigger className="browser-local-menu-anchor" tabIndex={-1} aria-label={copy}
      style={{ left: menu.x, top: menu.y }} />
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="workbench-context-menu" align="start" sideOffset={0} collisionPadding={8}
        onCloseAutoFocus={event => event.preventDefault()}>
        {menu.copy && <DropdownMenu.Item onSelect={() => controller.select(menu.id, 'copy')}>{copy}</DropdownMenu.Item>}
        {menu.link && <DropdownMenu.Item onSelect={() => controller.select(menu.id, 'copy-link')}>{copyLink}</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
