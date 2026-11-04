import { IconButton } from '@opencraft/design-system-web/button';
import { useCallback, useSyncExternalStore } from 'react';
import { KeyboardIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import type { BrowserPageId } from '@opencraft/browser-core';
import type { BrowserSurfaceHost } from './web-browser-surface-host';

export function BrowserKeyboardButton({ surfaces, pageId, beforeShow, touchChrome = false }: { surfaces?: BrowserSurfaceHost; pageId: BrowserPageId; beforeShow?: () => void; touchChrome?: boolean }) {
  const intl = useIntl();
  const subscribe = useCallback((listener: () => void) => surfaces?.onKeyboardState?.(listener) ?? (() => {}), [surfaces]);
  const snapshot = useCallback(() => surfaces?.keyboardState?.(pageId) ?? 'unavailable', [surfaces, pageId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === 'unavailable') return null;
  const Control = touchChrome ? IconButton : 'button';
  return <Control type="button" className={touchChrome ? "panel-mobile-dock__button" : "browser-toolbar-button"}
    aria-label={intl.formatMessage({ id: 'browser.keyboard', defaultMessage: 'Keyboard' })}
    disabled={state !== 'ready'} onClick={() => { beforeShow?.(); surfaces?.showKeyboard?.(pageId); }}
    title={intl.formatMessage({ id: 'browser.keyboard.hint', defaultMessage: 'Select a text field, then open the keyboard' })}>
    <KeyboardIcon size={touchChrome ? undefined : 15} />
  </Control>;
}
