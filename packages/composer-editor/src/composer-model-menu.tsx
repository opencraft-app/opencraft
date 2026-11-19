import { ModelCatalogRefresh } from "./model-catalog-refresh";
import { useState } from "react";
import { composerAgentSources, type ComposerAgentSource } from "./composer-agent-sources";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon } from "@opencraft/design-system-web/action-icons";
import { CheckIcon, SearchIcon, ModelIcon, LightningIcon, AddIcon, NewMessageIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { SettingsSwitch } from "@opencraft/extension-react";
import { modelChoiceFamilies, chooseFamilyModel } from "./model-choice-families";
import { modelEffortLabel } from "./model-choice-labels";
import { ModelCatalogStatus } from "./model-catalog-status";
import type { ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";

/** Browsing sources/search is local. Only an explicit choice writes a model. */
export function ComposerModelMenu({ catalog, selected, onSelect, effort, onEffortChange, serviceTier, onServiceTierChange,
  switchingAgentId, agentSelectionError, onConfigure, onStartHandoff, agentInHeader = false }: {
  readonly agentInHeader?: boolean;
  readonly catalog?: ComposerSelectionCatalog;
  readonly selected: string | null;
  readonly onSelect: (model: ComposerModelOption, group?: ComposerAgentModelGroup) => void;
  readonly effort: string | null;
  readonly onEffortChange: (value: string) => void;
  readonly serviceTier: string | null;
  readonly onServiceTierChange: (value: string | null) => void;
  readonly switchingAgentId: string | null;
  readonly agentSelectionError: { id: string; message: string } | null;
  readonly onConfigure?: () => void;
  readonly onStartHandoff?: () => void;
}) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  const sources = composerAgentSources(catalog, intl);
  const groups = catalog?.agentGroups?.length ? catalog.agentGroups : [{ id: "active", active: true, models: catalog?.models ?? [] }];
  const [browsing, setBrowsing] = useState<{ id: string; groupId: string } | null>(null);
  const browse = (item: ComposerAgentSource) => setBrowsing({ id: item.id, groupId: item.group.id });
  const availableSources = agentInHeader ? sources.filter(source => source.group.active && source.models.some(model => model.value === selected || model.id === selected)) : sources;
  const source = availableSources.find(source => source.id === browsing?.id)
    ?? availableSources.find(source => source.group.id === browsing?.groupId)
    ?? availableSources.find(source => source.group.active && source.models.some(model => model.value === selected || model.id === selected))
    ?? availableSources.find(source => source.group.active) ?? availableSources[0];
  if (!source) return <div className="opencraft-composer-model-browser">
    <ModelCatalogStatus emptyTitle={catalog?.agentsDisabled ? <FormattedMessage id="composer.agent.none" defaultMessage="No enabled agents have available models. Enable an agent or check its setup in settings." /> : undefined} emptyHint={catalog?.agentsDisabled ? null : undefined} />
    {!agentInHeader && catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={onConfigure}><FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" /></Menu.Item> : null}
  </div>;
  const families = modelChoiceFamilies(source.models);
  const selectedFamily = source.group.active ? families.find(family => family.models.some(model => model.value === selected || model.id === selected)) : undefined;
  const current = selectedFamily?.models.find(model => model.value === selected || model.id === selected);
  const variants = selectedFamily?.variants ?? [];
  const efforts = variants.length ? variants.map(variant => ({ value: variant.effort, label: variant.effort })) : current?.efforts ?? [];
  const activeEffort = variants.length ? variants.find(variant => variant.model.value === selected || variant.model.id === selected)?.effort : effort;
  const defaultEffort = variants.length ? variants.find(variant => variant.model.isDefault)?.effort ?? null : current?.defaultEffort ?? null;
  const refreshModel = current?.value ?? source.models[0]?.value;
  const fast = current?.serviceTiers?.find(tier => tier.id === "fast" || tier.name.toLowerCase() === "fast");
  const matches = families.filter(family => `${family.label} ${family.models.map(model => model.value).join(" ")}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale)));
  const searchLabel = intl.formatMessage({ id: "composer.model.search", defaultMessage: "Search models" });
  const choose = (model: ComposerModelOption) => onSelect(model, catalog?.agentGroups?.length ? source.group as ComposerAgentModelGroup : undefined);
  return <div className="opencraft-composer-model-browser">
    {!agentInHeader ? <div className="opencraft-composer-model-browser__sources" role="tablist" aria-label={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}>
      {sources.map(item => <Button key={item.id} size="sm" variant={source.id === item.id ? "secondary" : "ghost"}
        onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
        role="tab" aria-selected={source.id === item.id} tabIndex={source.id === item.id ? 0 : -1}
        onClick={() => { browse(item); setQuery(""); }} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const index = sources.findIndex(source => source.id === item.id);
          const next = event.key === "Home" ? 0 : event.key === "End" ? sources.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + sources.length) % sources.length;
          browse(sources[next]!); setQuery("");
          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}>
        {item.brand ? <AgentBrandIcon agent={item.brand} /> : <ModelIcon size={18} aria-hidden="true" />}
        {item.label}
      </Button>)}
    </div> : null}
    <label className="opencraft-composer-model-browser__search">
      <SearchIcon size={16} aria-hidden="true" />
      <input type="search" value={query} aria-label={searchLabel} placeholder={searchLabel} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape" || event.nativeEvent.isComposing) return;
          event.stopPropagation();
          if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus(); }
        }} />
    </label>
    <div className="opencraft-composer-model-browser__models">
      <ModelCatalogRefresh key={source.id} catalog={catalog} model={refreshModel} enabled={!!source.group.active} />
      {matches.map(family => <Menu.Item key={family.id} data-model-choice className="opencraft-composer-selection-menu__item"
        data-selected={family === selectedFamily || undefined} disabled={!!switchingAgentId || family.models.every(model => model.policyRestricted)}
        onSelect={event => { event.preventDefault(); choose(chooseFamilyModel(family, selected)); }}>
        <span className="opencraft-composer-selection-menu__copy"><span className="opencraft-composer-selection-menu__label">{family.label}</span></span>
        {family.models.some(model => model.configuredRole === "fallback") ? <span className="opencraft-composer-model-role"><FormattedMessage id="composer.model.fallbackShort" defaultMessage="Backup" /></span> : null}
        {family === selectedFamily ? <CheckIcon size={16} aria-hidden="true" /> : null}
      </Menu.Item>)}
      {source.models.length === 1 && source.models[0].description ? <div className="opencraft-composer-selection-menu__status" role="note">{source.models[0].description}</div> : null}
      {query.trim() && !matches.length && families.length ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.model.noResults" defaultMessage="No models match your search." /></div> : null}
      {source.group.loading || source.group.error || source.models.length === 0 ? <ModelCatalogStatus loading={source.group.loading} error={!!source.group.error} retry={source.group.retry} /> : null}
      {switchingAgentId === source.group.id ? <div className="opencraft-composer-selection-menu__status" role="status"><FormattedMessage id="workIn.switchingAgent" defaultMessage="Switching Agent…" /></div> : null}
      {agentSelectionError?.id === source.group.id ? <div className="opencraft-composer-selection-menu__status is-error" role="alert">{agentSelectionError.message}</div> : null}
      {!source.group.loading && !source.group.error && source.models.length > 0 && selected !== null && !groups.some(group => group.active && group.models.some(model => model.value === selected || model.id === selected)) ? <div className="opencraft-composer-selection-menu__status is-error"><FormattedMessage id="composer.model.unavailable" defaultMessage="The selected model is unavailable. Choose another model." /></div> : null}
    </div>
    {efforts.length ? <div className="opencraft-composer-model-browser__reasoning" role="group" aria-label={intl.formatMessage({ id: "chat.reasoning", defaultMessage: "Reasoning" })}>
      <div className="opencraft-composer-model-browser__section-label"><FormattedMessage id="chat.reasoning" defaultMessage="Reasoning" />
        {defaultEffort && efforts.some(option => option.value === defaultEffort) ? <IconButton size="accessory" variant="ghost"
          aria-label={intl.formatMessage({ id: "composer.resetEffort", defaultMessage: "Reset reasoning to model default" })}
          disabled={!!switchingAgentId || defaultEffort === activeEffort || current?.policyRestrictedEfforts?.includes(defaultEffort)}
          onClick={() => { const variant = variants.find(variant => variant.effort === defaultEffort); if (variant) choose(variant.model); else onEffortChange(defaultEffort); }}>
          <ResetIcon size={14} aria-hidden="true" />
        </IconButton> : null}
      </div>
      <div className="opencraft-composer-model-browser__efforts">{efforts.map(option => <Button key={option.value} size="sm" density="compact" variant={activeEffort === option.value ? "secondary" : "ghost"}
        aria-pressed={activeEffort === option.value} disabled={!!switchingAgentId || current?.policyRestrictedEfforts?.includes(option.value)}
        onClick={() => { const variant = variants.find(variant => variant.effort === option.value); if (variant) choose(variant.model); else onEffortChange(option.value); }}>
        {modelEffortLabel(intl, option.value, option.label)}
      </Button>)}</div>
    </div> : null}
    {fast ? <div className="opencraft-composer-model-browser__fast">
      <LightningIcon size={16} aria-hidden="true" /><span><FormattedMessage id="composer.model.fastMode" defaultMessage="Fast mode" /></span>
      <SettingsSwitch checked={serviceTier === fast.id} disabled={!!switchingAgentId} onCheckedChange={checked => onServiceTierChange(checked ? fast.id : null)}
        label={intl.formatMessage({ id: "composer.model.fastMode", defaultMessage: "Fast mode" })} />
    </div> : null}
    {onStartHandoff ? <Menu.Item className="opencraft-composer-selection-menu__item opencraft-composer-model-browser__handoff" onSelect={onStartHandoff}>
      <NewMessageIcon size={16} aria-hidden="true" />
      <FormattedMessage id="composer.handoff.action" defaultMessage="Handoff to new thread" />
    </Menu.Item> : null}
    {!agentInHeader && catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item opencraft-composer-model-browser__configure" onSelect={onConfigure}>
      <AddIcon size={16} aria-hidden="true" />{groups.find(group => group.active)?.models.length === 0
        ? <FormattedMessage id="composer.model.add" defaultMessage="Add a model…" />
        : <FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" />}
    </Menu.Item> : null}
  </div>;
}
