import { useEffect } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { useAsyncNotices } from '../components/async-notices-context';
import type { WebBrowserPageRuntime } from './web-browser-runtime';

/** One subscription per Workbench notification owner, independent of its views. */
export function BrowserInputNotices({ pages }: { readonly pages: WebBrowserPageRuntime }) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  useEffect(() => pages.onInputError((pageId, kind) => {
    const message = kind === 'focus'
      ? intl.formatMessage({ id: 'browser.input.focusAgain', defaultMessage: 'Focus the text field and try again.' })
      : kind === 'copy'
        ? intl.formatMessage({ id: 'browser.input.copyFailed', defaultMessage: 'Could not copy. Try again.' })
        : kind === 'control'
          ? intl.formatMessage({ id: 'browser.input.controlFailed', defaultMessage: 'Could not take control of this page. Try the action again.' })
          : intl.formatMessage({ id: 'browser.input.editFailed', defaultMessage: 'Could not enter text. Focus the field and try again.' });
    notices.warning({ key: `browser-input:${pageId}:${kind}`, message });
  }), [pages, intl, notices]);
  return null;
}
