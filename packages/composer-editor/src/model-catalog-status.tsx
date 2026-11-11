import type { ReactNode } from "react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { AlertIcon, ModelIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage } from "@opencraft/i18n/react";

/** Catalog diagnostics stay with their owner; this surface explains the next action. */
export function ModelCatalogStatus({ error, loading, retry, emptyTitle, emptyHint }: {
  readonly error?: boolean;
  readonly loading?: boolean;
  readonly retry?: () => void;
  readonly emptyTitle?: ReactNode;
  readonly emptyHint?: ReactNode;
}) {
  const Icon = error ? AlertIcon : ModelIcon;
  return <div className="opencraft-composer-model-status" aria-busy={loading || undefined}>
    <Icon className="opencraft-composer-model-status__icon" size={20} aria-hidden="true" />
    <div className="opencraft-composer-model-status__copy">
      <div className="opencraft-composer-model-status__title">
        {loading ? <FormattedMessage id="workIn.loadingModels" defaultMessage="Loading models…" />
          : error ? <FormattedMessage id="composer.model.failedTitle" defaultMessage="Couldn't load models" />
          : emptyTitle ?? <FormattedMessage id="composer.model.emptyTitle" defaultMessage="No models available yet" />}
      </div>
      {emptyHint === null && !error && !loading ? null : <div className="opencraft-composer-model-status__hint">
        {error || loading ? <FormattedMessage id="composer.model.checkSetup" defaultMessage="Check this Agent's setup, then try again." />
          : emptyHint ?? <FormattedMessage id="composer.model.setupHint" defaultMessage="Add a model to start chatting." />}
      </div>}
    </div>
    {retry && (error || loading) ? <DropdownMenu.Item
      className="opencraft-composer-selection-menu__item opencraft-composer-model-status__retry"
      disabled={loading}
      onSelect={event => { event.preventDefault(); retry(); }}>
      <ResetIcon size={14} aria-hidden="true" />
      <FormattedMessage id="workIn.retry" defaultMessage="Retry" />
    </DropdownMenu.Item> : null}
  </div>;
}
