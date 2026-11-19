import { useEffect, useRef, useState } from "react";
import { IconButton } from "@opencraft/design-system-web/button";
import { RefreshIcon } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import type { ComposerSelectionCatalog } from "./composer-editor";

/** Refresh is independent of selecting a model; the open menu and draft stay put. */
export function ModelCatalogRefresh({ catalog, model, enabled = true }: {
  readonly catalog?: Pick<ComposerSelectionCatalog, "canRefreshModels" | "refreshModels">;
  readonly model?: string;
  readonly enabled?: boolean;
}) {
  const intl = useIntl();
  const [phase, setPhase] = useState<"pending" | "failed" | "done" | null>(null);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const canRefresh = enabled && model && catalog?.refreshModels && catalog.canRefreshModels?.(model);
  const refresh = async () => {
    if (!canRefresh || phase === "pending") return;
    const current = ++epoch.current;
    setPhase("pending");
    try {
      await catalog!.refreshModels!(model!);
      if (epoch.current === current) setPhase("done");
    } catch {
      if (epoch.current === current) setPhase("failed");
    }
  };
  return <>
    <div className="opencraft-composer-model-browser__catalog-heading">
      <Menu.Label className="opencraft-composer-selection-menu__heading"><FormattedMessage id="chat.model" defaultMessage="Model" /></Menu.Label>
      {canRefresh ? <IconButton size="accessory" variant="ghost" disabled={phase === "pending"} aria-busy={phase === "pending" || undefined}
        aria-label={intl.formatMessage({ id: "composer.model.refresh", defaultMessage: "Refresh models" })}
        title={intl.formatMessage({ id: "composer.model.refresh", defaultMessage: "Refresh models" })}
        onClick={() => { void refresh(); }}><RefreshIcon size={16} aria-hidden="true" /></IconButton> : null}
    </div>
    {phase ? <div className={`opencraft-composer-selection-menu__status${phase === "failed" ? " is-error" : ""}`} role={phase === "failed" ? "alert" : "status"}>
      {phase === "pending" ? <FormattedMessage id="composer.model.refreshing" defaultMessage="Refreshing models…" />
        : phase === "failed" ? <FormattedMessage id="composer.model.refreshFailed" defaultMessage="Couldn't refresh models. Your current list and selection are unchanged. Try again." />
        : <FormattedMessage id="composer.model.refreshed" defaultMessage="Models updated." />}
    </div> : null}
  </>;
}
