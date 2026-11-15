import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon, type AgentBrand } from "@opencraft/design-system-web/action-icons";
import { CheckIcon, SearchIcon, ModelIcon, LightningIcon, AddIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { SettingsSwitch } from "@opencraft/extension-react";
import { modelChoiceFamilies, chooseFamilyModel } from "./model-choice-families";
import { modelEffortLabel } from "./model-choice-labels";
import { ModelCatalogStatus } from "./model-catalog-status";
import type { ComposerAgentCycleDirection, ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";

const brands: Record<string, { brand: AgentBrand; name: string }> = {
  codex: { brand: "codex", name: "Codex" }, cursor: { brand: "cursor", name: "Cursor" },
  "claude-code": { brand: "claude", name: "Claude Code" }, codebuddy: { brand: "codebuddy", name: "CodeBuddy" },
};

/** Browsing sources/search is local. Only an explicit choice writes a model. */
export function ComposerModelMenu({ catalog, selected, onSelect, effort, onEffortChange, serviceTier, onServiceTierChange,
  switchingAgentId, agentSelectionError, onConfigure, agentCycleRequest }: {
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
  readonly agentCycleRequest?: { readonly direction: ComposerAgentCycleDirection; readonly nonce: number } | null;
}) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  const apiLabel = intl.formatMessage({ id: "composer.model.api", defaultMessage: "API models" });
  const currentAgentId = catalog?.currentAgentId ?? null;
  const currentAgentLabel = catalog?.currentAgentLabel ?? null;
  const currentAgentFallbackLabel = currentAgentLabel
    || (currentAgentId === null ? "" : currentAgentId === "dsh" || currentAgentId === "api" ? apiLabel : brands[currentAgentId]?.name || currentAgentId);
  const currentTagLabel = intl.formatMessage({ id: "composer.agent.currentTag", defaultMessage: "Current conversation" });
  const groups = catalog?.agentGroups?.length ? catalog.agentGroups : [{ id: "active", label: "", active: true,
    models: catalog?.models ?? [], loading: catalog?.isFetching, error: catalog?.modelError, retry: catalog?.retryModels }];
  type Source = { id: string; agentId: string; label: string; brand?: AgentBrand; group: typeof groups[number]; models: ComposerModelOption[] };
  const sources: Source[] = [];
  for (const group of groups) {
    const scoped = new Map<string, Source>();
    for (const model of group.models) {
      const identity = model.agentId ? brands[model.agentId] : undefined;
      const key = model.agentId ?? "host";
      let source = scoped.get(key);
      if (!source) {
        const name = key === "dsh" ? apiLabel : model.agentLabel || group.label || intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" });
        source = { id: `${group.id}:${key}`, agentId: key, label: groups.length > 1 && group.label !== name ? `${name} · ${group.label}` : name,
          brand: identity?.brand, group, models: [] };
        scoped.set(key, source); sources.push(source);
      }
      source.models.push(model);
    }
    if (!scoped.size && (group.loading || group.error || !catalog?.onConfigureAgents)) sources.push({ id: `${group.id}:api`, agentId: "api", label: group.label || apiLabel, group, models: [] });
  }
  // A stale or failed current-Agent catalog must not hide the thread's Agent.
  if (currentAgentId !== null && !sources.some(source => source.agentId === currentAgentId)) {
    const group = groups.find(candidate => candidate.active) ?? groups[0];
    if (group !== undefined) sources.push({
      id: `${group.id}:${currentAgentId}`, agentId: currentAgentId,
      label: currentAgentFallbackLabel,
      brand: brands[currentAgentId]?.brand, group, models: [],
    });
  }
  const brandOrder: Record<string, number> = { codex: 0, claude: 1, cursor: 2, codebuddy: 3 };
  sources.sort((left, right) => (brandOrder[left.brand ?? ""] ?? 4) - (brandOrder[right.brand ?? ""] ?? 4));
  const [browsing, setBrowsing] = useState<{ id: string; groupId: string } | null>(null);
  const browse = (item: Source) => setBrowsing({ id: item.id, groupId: item.group.id });
  const source = sources.find(source => source.id === browsing?.id)
    ?? sources.find(source => source.group.id === browsing?.groupId)
    ?? sources.find(source => source.group.active && source.models.some(model => model.value === selected || model.id === selected))
    ?? sources.find(source => source.agentId === currentAgentId)
    ?? sources.find(source => source.group.active) ?? sources[0];
  const lastCycleNonce = useRef(0);
  useEffect(() => {
    if (!agentCycleRequest || agentCycleRequest.nonce === lastCycleNonce.current || !source || sources.length === 0) return;
    lastCycleNonce.current = agentCycleRequest.nonce;
    const index = sources.findIndex(item => item.id === source.id);
    const next = sources[(index + agentCycleRequest.direction + sources.length) % sources.length];
    if (next) { browse(next); setQuery(""); }
  }, [agentCycleRequest, source, sources, browse]);
  const sourceIcon = (brand: AgentBrand | undefined) => brand
    ? <AgentBrandIcon agent={brand} size={18} />
    : <ModelIcon size={18} aria-hidden="true" />;
  if (!source) return <div className="opencraft-composer-model-browser">
    <ModelCatalogStatus emptyTitle={catalog?.agentsDisabled ? <FormattedMessage id="composer.agent.none" defaultMessage="No enabled agents have available models. Enable an agent or check its setup in settings." /> : undefined} emptyHint={catalog?.agentsDisabled ? null : undefined} />
    {catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={onConfigure}><FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" /></Menu.Item> : null}
  </div>;
  const families = modelChoiceFamilies(source.models);
  const selectedFamily = source.group.active ? families.find(family => family.models.some(model => model.value === selected || model.id === selected)) : undefined;
  const current = selectedFamily?.models.find(model => model.value === selected || model.id === selected);
  const variants = selectedFamily?.variants ?? [];
  const efforts = variants.length ? variants.map(variant => ({ value: variant.effort, label: variant.effort })) : current?.efforts ?? [];
  const activeEffort = variants.length ? variants.find(variant => variant.model.value === selected || variant.model.id === selected)?.effort : effort;
  const defaultEffort = variants.length ? variants.find(variant => variant.model.isDefault)?.effort ?? null : current?.defaultEffort ?? null;
  const fast = current?.serviceTiers?.find(tier => tier.id === "fast" || tier.name.toLowerCase() === "fast");
  const matches = families.filter(family => `${family.label} ${family.models.map(model => model.value).join(" ")}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale)));
  const searchLabel = intl.formatMessage({ id: "composer.model.search", defaultMessage: "Search models" });
  const choose = (model: ComposerModelOption) => onSelect(model, catalog?.agentGroups?.length ? source.group as ComposerAgentModelGroup : undefined);
  const startsNewThread = catalog?.agentContinuation?.startsNewThread === true;
  const currentAgent = (item: Source) => currentAgentId !== null && item.agentId === currentAgentId;
  const tabName = (item: Source) => currentAgent(item)
    ? intl.formatMessage({ id: "composer.agent.tabCurrent", defaultMessage: "Agent: {agent}, current conversation" }, { agent: item.label })
    : intl.formatMessage({ id: "composer.agent.tabName", defaultMessage: "Agent: {agent}" }, { agent: item.label });
  const sourceLabel = currentAgentId === null ? source.label
    : `${source.label} · ${currentAgent(source) ? currentTagLabel : intl.formatMessage({ id: "composer.agent.currentAgent", defaultMessage: "Current: {agent}" }, { agent: currentAgentFallbackLabel })}`;
  const showHandoffNotice = startsNewThread && currentAgentId !== null && !currentAgent(source) && source.models.length > 0;
  return <div className="opencraft-composer-model-browser">
    <div className="opencraft-composer-model-browser__sources" role="tablist" aria-label={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}>
      {sources.map(item => <IconButton key={item.id} size="accessory" variant="ghost"
        onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
        role="tab" aria-selected={source.id === item.id} tabIndex={source.id === item.id ? 0 : -1}
        title={currentAgent(item)
          ? intl.formatMessage({ id: "composer.agent.currentTitle", defaultMessage: "{agent} (current conversation)" }, { agent: item.label })
          : item.label}
        aria-label={tabName(item)} data-current-agent={currentAgent(item) || undefined}
        onClick={() => { browse(item); setQuery(""); }} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const index = sources.findIndex(source => source.id === item.id);
          const next = event.key === "Home" ? 0 : event.key === "End" ? sources.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + sources.length) % sources.length;
          browse(sources[next]!); setQuery("");
          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}>
        {sourceIcon(item.brand)}
      </IconButton>)}
      <span className="opencraft-composer-model-browser__source-name" role="presentation" title={sourceLabel}>
        {sourceLabel}
      </span>
    </div>
    {showHandoffNotice ? <div className="opencraft-composer-selection-menu__status opencraft-composer-model-browser__handoff" role="status">
      <FormattedMessage id="composer.agent.newThreadNotice" defaultMessage="Choosing a model from another Agent starts a new conversation with this thread's context." />
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
      <Menu.Label className="opencraft-composer-selection-menu__heading"><FormattedMessage id="chat.model" defaultMessage="Model" /></Menu.Label>
      {matches.map(family => <Menu.Item key={family.id} data-model-choice className="opencraft-composer-selection-menu__item"
        data-selected={family === selectedFamily || undefined} disabled={!!switchingAgentId || family.models.every(model => model.policyRestricted)}
        onSelect={event => { event.preventDefault(); choose(chooseFamilyModel(family, selected)); }}>
        <span className="opencraft-composer-selection-menu__copy"><span className="opencraft-composer-selection-menu__label">{family.label}</span></span>
        {family.models.some(model => model.configuredRole === "fallback") ? <span className="opencraft-composer-model-role"><FormattedMessage id="composer.model.fallbackShort" defaultMessage="Backup" /></span> : null}
        {family === selectedFamily ? <CheckIcon size={16} aria-hidden="true" /> : null}
      </Menu.Item>)}
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
    {catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item opencraft-composer-model-browser__configure" onSelect={onConfigure}>
      <AddIcon size={16} aria-hidden="true" />{groups.find(group => group.active)?.models.length === 0
        ? <FormattedMessage id="composer.model.add" defaultMessage="Add a model…" />
        : <FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" />}
    </Menu.Item> : null}
  </div>;
}
