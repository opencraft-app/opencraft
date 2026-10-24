import { useCallback, useSyncExternalStore } from 'react';
import { KeyboardIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import type { BrowserPageId } from '@opencraft/browser-core';
import type { BrowserSurfaceHost } from './web-browser-surface-host';

export function BrowserKeyboardButton({ surfaces, pageId, beforeShow }: { surfaces?: BrowserSurfaceHost; pageId: BrowserPageId; beforeShow?: () => void }) {
  const intl = useIntl();
  const subscribe = useCallback((listener: () => void) => surfaces?.onKeyboardState?.(listener) ?? (() => {}), [surfaces]);
  const snapshot = useCallback(() => surfaces?.keyboardState?.(pageId) ?? 'unavailable', [surfaces, pageId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === 'unavailable') return null;
  return <button type="button" className="browser-toolbar-button"
    aria-label={intl.formatMessage({ id: 'browser.keyboard', defaultMessage: 'Keyboard' })}
    disabled={state !== 'ready'} onClick={() => { beforeShow?.(); surfaces?.showKeyboard?.(pageId); }}
    title={intl.formatMessage({ id: 'browser.keyboard.hint', defaultMessage: 'Select a text field, then open the keyboard' })}>
    <KeyboardIcon size={15} />
  </button>;
}
