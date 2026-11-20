import { Button } from '@opencraft/design-system-web/button';
import { useCallback, useSyncExternalStore } from 'react';
import { PersonIcon, SparklesIcon } from '@opencraft/design-system-web/action-icons';
import { useIntl } from '@opencraft/i18n/react';
import type { BrowserPageId } from '@opencraft/browser-core';
import type { BrowserSurfaceHost } from './web-browser-surface-host';

export function BrowserControlButton({ surfaces, pageId, showLabel = false }: { surfaces?: BrowserSurfaceHost; pageId: BrowserPageId; showLabel?: boolean }) {
  const intl = useIntl();
  const subscribe = useCallback((listener: () => void) => surfaces?.onControlState?.(listener) ?? (() => {}), [surfaces]);
  const snapshot = useCallback(() => surfaces?.controlState?.(pageId) ?? 'unavailable', [surfaces, pageId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === 'unavailable') return null;
  const human = state === 'human';
  const label = human
    ? intl.formatMessage({ id: 'browser.control.human', defaultMessage: 'You are controlling' })
    : state === 'elsewhere'
      ? intl.formatMessage({ id: 'browser.control.elsewhere', defaultMessage: 'Another client' })
      : intl.formatMessage({ id: 'browser.control.ai', defaultMessage: 'AI control' });
  const hint = human
    ? intl.formatMessage({ id: 'browser.control.releaseHint', defaultMessage: 'Return control to AI. AI can also take over automatically when it operates.' })
    : intl.formatMessage({ id: 'browser.control.takeoverHint', defaultMessage: 'Take control to operate this page. AI will automatically take over for its next operation.' });
  return <Button type="button" size={showLabel ? 'md' : 'sm'} variant="secondary" contentLayout="row"
    aria-label={label} aria-pressed={human} title={hint}
    onClick={() => human ? surfaces?.releaseControl?.(pageId) : surfaces?.takeControl?.(pageId)}>
    {human || state === 'elsewhere' ? <PersonIcon /> : <SparklesIcon />}
    <span>{label}</span>
  </Button>;
}
