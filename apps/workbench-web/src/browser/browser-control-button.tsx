import { useCallback, useSyncExternalStore } from 'react';
import { PointerIcon, PointerOffIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import type { BrowserPageId } from '@opencraft/browser-core';
import type { BrowserSurfaceHost } from './web-browser-surface-host';

export function BrowserControlButton({ surfaces, pageId }: { surfaces?: BrowserSurfaceHost; pageId: BrowserPageId }) {
  const intl = useIntl();
  const subscribe = useCallback((listener: () => void) => surfaces?.onControlState?.(listener) ?? (() => {}), [surfaces]);
  const snapshot = useCallback(() => surfaces?.controlState?.(pageId) ?? 'unavailable', [surfaces, pageId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === 'unavailable') return null;
  const own = state === 'human' || state === 'agent';
  const label = own
    ? intl.formatMessage({ id: 'browser.control.release', defaultMessage: 'Release' })
    : intl.formatMessage({ id: 'browser.control.take', defaultMessage: 'Control' });
  const hint = own
    ? intl.formatMessage({ id: 'browser.control.releaseHint', defaultMessage: 'Release input control so another client or Agent can operate' })
    : state === 'elsewhere'
      ? intl.formatMessage({ id: 'browser.control.takeoverHint', defaultMessage: 'Another client or Agent is controlling this page. Take control' })
      : intl.formatMessage({ id: 'browser.control.viewingHint', defaultMessage: 'Viewing shared page. Take input control' });
  return <button type="button" className="browser-toolbar-button"
    aria-label={label} title={hint} onClick={() => own ? surfaces?.releaseControl?.(pageId) : surfaces?.takeControl?.(pageId)}>
    {own ? <PointerOffIcon size={15} /> : <PointerIcon size={15} />}
  </button>;
}
