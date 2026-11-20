import { ModelCatalogRefresh } from "./model-catalog-refresh";
import { useState } from "react";
import { composerAgentSources, type ComposerAgentSource } from "./composer-agent-sources";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon, CloudIcon, LaptopIcon, ServerIcon, WarningIcon } from "@opencraft/design-system-web/action-icons";
import { CheckIcon, SearchIcon, ModelIcon, LightningIcon, AddIcon, NewMessageIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { SegmentedControl, SettingsSwitch } from "@opencraft/extension-react";
import { modelChoiceFamilies, chooseFamilyModel } from "./model-choice-families";
import { modelEffortLabel } from "./model-choice-labels";
import { ModelCatalogStatus } from "./model-catalog-status";
import type { ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";
import "./composer-model-menu.scss";

function MachineGlyph({ role, isLocal }: { readonly role?: "local" | "server" | "cloud"; readonly isLocal?: boolean }) {
  const Icon = isLocal || role === "local" ? LaptopIcon : role === "cloud" ? CloudIcon : ServerIcon;
  return <Icon size={14} aria-hidden="true" />;
}

/** Browsing sources/search is local. Only an explicit choice writes a model. */
export function ComposerModelMenu({ catalog, selected, onSelect, effort, onEffortChange, serviceTier, onServiceTierChange,
  switchingAgentId, agentSelectionError, onConfigure, onStartHandoff, onRequestClose, agentInHeader = false }: {
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
  readonly onRequestClose?: () => void;
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

  const machineSections = (() => {
    const sections = new Map<string, {
      key: string;
      label: string;
      role?: "local" | "server" | "cloud";
      isLocal?: boolean;
      isOrigin?: boolean;
      isActiveTarget: boolean;
      items: ComposerAgentSource[];
    }>();
    for (const item of sources) {
      const key = item.group.machineId ?? item.group.id;
      const existing = sections.get(key);
      if (existing) {
        existing.items.push(item);
        if (item.group.active) existing.isActiveTarget = true;
      } else {
        sections.set(key, {
          key,
          label: item.group.machineLabel || item.group.label,
          role: item.group.machineRole,
          isLocal: item.group.isLocalMachine,
          isOrigin: item.group.isConversationMachine,
          isActiveTarget: Boolean(item.group.active),
          items: [item],
        });
      }
    }
    return [...sections.values()];
  })();
  const showMachineSections = machineSections.length > 1 && machineSections.some(section => Boolean(section.label));
  const selectedMachineKey = source.group.machineId ?? source.group.id;
  const selectedMachineSection = showMachineSections
    ? (machineSections.find(section => section.key === selectedMachineKey) ?? machineSections[0])
    : undefined;
  const visibleSources = selectedMachineSection ? selectedMachineSection.items : sources;
  const anyCrossDeviceActive = groups.some(group => "crossDevice" in group && Boolean(group.crossDevice && group.active));

  const selectMachineSection = (section: (typeof machineSections)[number]) => {
    const matched = section.items.find(item => (source.brand && item.brand === source.brand) || item.agentLabel === source.agentLabel)
      ?? section.items.find(item => item.group.active)
      ?? section.items[0];
    if (matched) {
      browse(matched);
      setQuery("");
    }
  };

  const families = modelChoiceFamilies(source.models);
  const activeSource = availableSources.find(item => item.group.active && item.models.some(model => model.value === selected || model.id === selected));
  const activeFamilyLabel = activeSource
    ? modelChoiceFamilies(activeSource.models).find(family => family.models.some(model => model.value === selected || model.id === selected))?.label ?? null
    : null;
  const selectedFamily = source.group.active ? families.find(family => family.models.some(model => model.value === selected || model.id === selected)) : undefined;
  const preferredFamily = selectedFamily
    ?? families.find(family => family.models.some(model => model.value === selected || model.id === selected))
    ?? (activeFamilyLabel ? families.find(family => family.label === activeFamilyLabel) : undefined)
    ?? families.find(family => family.models.some(model => model.isDefault))
    ?? families[0];
  const preferredModel = preferredFamily
    ? chooseFamilyModel(preferredFamily, selected)
    : (source.models.find(model => model.isDefault) ?? source.models[0]);
  const current = selectedFamily?.models.find(model => model.value === selected || model.id === selected);
  const variants = selectedFamily?.variants ?? [];
  const efforts = variants.length ? variants.map(variant => ({ value: variant.effort, label: variant.effort })) : current?.efforts ?? [];
  const activeEffort = variants.length ? variants.find(variant => variant.model.value === selected || variant.model.id === selected)?.effort : effort;
  const defaultEffort = variants.length ? variants.find(variant => variant.model.isDefault)?.effort ?? null : current?.defaultEffort ?? null;
  const refreshModel = current?.value ?? source.models[0]?.value;
  const fast = current?.serviceTiers?.find(tier => tier.id === "fast" || tier.name.toLowerCase() === "fast");
  const matches = families.filter(family => `${family.label} ${family.models.map(model => model.value).join(" ")}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale)));
  const searchLabel = intl.formatMessage({ id: "composer.model.search", defaultMessage: "Search models" });
  const switchingAcrossMachines = Boolean(
    !source.group.active
    && (source.group.crossDevice || (source.group.isConversationMachine && anyCrossDeviceActive)),
  );
  const choose = (model: ComposerModelOption, forceClose = false) => {
    onSelect(model, catalog?.agentGroups?.length ? source.group as ComposerAgentModelGroup : undefined);
    if (forceClose || switchingAcrossMachines) onRequestClose?.();
  };
  const moveAgentFocus = (currentId: string, key: string, tablist: HTMLElement | null) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return false;
    const index = visibleSources.findIndex(entry => entry.id === currentId);
    if (index < 0) return false;
    const next = key === "Home" ? 0 : key === "End" ? visibleSources.length - 1 : (index + (key === "ArrowLeft" ? -1 : 1) + visibleSources.length) % visibleSources.length;
    browse(visibleSources[next]!); setQuery("");
    tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    return true;
  };
  return <div className="opencraft-composer-model-browser">
    {!agentInHeader && showMachineSections ? <div className="opencraft-composer-model-browser__machines">
      <div className="opencraft-composer-model-browser__machines-label">
        <FormattedMessage id="composer.model.machineSection" defaultMessage="Execution machine" />
      </div>
      <SegmentedControl
        appearance="inset"
        className="opencraft-composer-model-browser__machine-segmented"
        label={intl.formatMessage({ id: "composer.model.machineSection", defaultMessage: "Execution machine" })}
        value={selectedMachineSection?.key ?? machineSections[0]!.key}
        onValueChange={nextKey => {
          const found = machineSections.find(section => section.key === nextKey);
          if (found) selectMachineSection(found);
        }}
        options={machineSections.map(section => {
          const isSelectedMachine = selectedMachineSection?.key === section.key;
          const badgeTone = section.isActiveTarget && isSelectedMachine ? "current" : "neutral";
          return {
            value: section.key,
            label: (
              <span
                className="opencraft-composer-model-browser__machine-option"
                data-current-machine={section.isOrigin ? "true" : undefined}
                data-active-target={section.isActiveTarget ? "true" : undefined}
              >
                <MachineGlyph role={section.role} isLocal={section.isLocal} />
                <span className="opencraft-composer-model-browser__machine-name" title={section.label}>{section.label}</span>
                <span className="opencraft-composer-model-browser__machine-badge" data-tone={badgeTone}>
                  {section.isActiveTarget && section.isOrigin
                    ? (section.isLocal
                        ? <FormattedMessage id="composer.model.currentLocalMachine" defaultMessage="Current · Local" />
                        : <FormattedMessage id="composer.model.currentMachine" defaultMessage="Current" />)
                    : section.isActiveTarget
                      ? (section.isLocal
                          ? <FormattedMessage id="composer.model.switchedLocalMachine" defaultMessage="Switched · Local" />
                          : <FormattedMessage id="composer.model.switchedMachine" defaultMessage="Switched" />)
                      : section.isOrigin
                        ? <FormattedMessage id="composer.model.originMachine" defaultMessage="Original" />
                        : section.isLocal
                          ? <FormattedMessage id="composer.model.localMachine" defaultMessage="Local" />
                          : <FormattedMessage id="settings.agents.remote" defaultMessage="Remote" />}
                </span>
              </span>
            ),
          };
        })}
      />
    </div> : null}
    {!agentInHeader ? <div className="opencraft-composer-model-browser__sources" role="tablist" aria-label={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}>
      {visibleSources.map(item => {
        const accessibleLabel = showMachineSections && selectedMachineSection?.label
          ? `${item.agentLabel} · ${selectedMachineSection.label}`
          : item.label;
        return <Button key={item.id} size="sm" variant={source.id === item.id ? "secondary" : "ghost"}
          onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
          role="tab" aria-selected={source.id === item.id} aria-label={accessibleLabel} title={accessibleLabel} tabIndex={source.id === item.id ? 0 : -1}
          onClick={() => { browse(item); setQuery(""); }} onKeyDown={event => {
            if (!moveAgentFocus(item.id, event.key, event.currentTarget.parentElement)) return;
            event.preventDefault(); event.stopPropagation();
          }}>
          {item.brand ? <AgentBrandIcon agent={item.brand} /> : <ModelIcon size={18} aria-hidden="true" />}
          {showMachineSections ? item.agentLabel : item.label}
        </Button>;
      })}
    </div> : null}
    {source.group.crossDevice && !selectedMachineSection?.isActiveTarget ? <div className="opencraft-composer-model-browser__cross-device-notice" role="note">
      <div className="opencraft-composer-model-browser__cross-device-head">
        <WarningIcon size={14} aria-hidden="true" />
        <div className="opencraft-composer-model-browser__cross-device-copy">
          <div className="opencraft-composer-model-browser__cross-device-title">
            <FormattedMessage
              id="composer.model.crossMachineTitle"
              defaultMessage="Continue this conversation on {machine}"
              values={{ machine: source.group.machineLabel || source.group.label }}
            />
          </div>
          <div className="opencraft-composer-model-browser__cross-device-desc">
            <FormattedMessage
              id="composer.model.crossMachineHint"
              defaultMessage="Only conversation context (JSONL) is synced. Execution machine and system environment will change, so tasks may not run as before."
              values={{ machine: source.group.machineLabel || source.group.label }}
            />
          </div>
        </div>
      </div>
      {!source.group.active && preferredModel && !preferredModel.policyRestricted ? (
        <Button
          size="sm"
          variant="primary"
          className="opencraft-composer-model-browser__switch-machine-btn"
          disabled={!!switchingAgentId}
          onClick={() => choose(preferredModel, true)}
        >
          <FormattedMessage
            id="composer.model.switchToMachineAgent"
            defaultMessage="Switch to {machine} · {agent}"
            values={{
              machine: source.group.machineLabel || source.group.label,
              agent: source.agentLabel,
            }}
          />
        </Button>
      ) : null}
    </div> : (source.group.crossDevice && !source.group.active && preferredModel && !preferredModel.policyRestricted ? (
      <div className="opencraft-composer-model-browser__return-origin">
        <Button
          size="sm"
          variant="primary"
          className="opencraft-composer-model-browser__switch-machine-btn"
          disabled={!!switchingAgentId}
          onClick={() => choose(preferredModel, true)}
        >
          <FormattedMessage
            id="composer.model.switchToMachineAgent"
            defaultMessage="Switch to {machine} · {agent}"
            values={{
              machine: source.group.machineLabel || source.group.label,
              agent: source.agentLabel,
            }}
          />
        </Button>
      </div>
    ) : (!source.group.active && source.group.isConversationMachine && anyCrossDeviceActive && preferredModel && !preferredModel.policyRestricted ? (
      <div className="opencraft-composer-model-browser__return-origin">
        <Button
          size="sm"
          variant="secondary"
          className="opencraft-composer-model-browser__switch-machine-btn"
          disabled={!!switchingAgentId}
          onClick={() => choose(preferredModel, true)}
        >
          <FormattedMessage
            id="composer.model.returnToOriginMachine"
            defaultMessage="Return to original machine ({machine})"
            values={{ machine: source.group.machineLabel || source.group.label }}
          />
        </Button>
      </div>
    ) : null))}
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
        onSelect={event => {
          if (!switchingAcrossMachines) event.preventDefault();
          choose(chooseFamilyModel(family, selected));
        }}>
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
    {onStartHandoff ? <Menu.Item className="opencraft-composer-selection-menu__item opencraft-composer-model-browser__handoff" onSelect={() => {
      if (!source.group.active && preferredModel && !preferredModel.policyRestricted) choose(preferredModel, true);
      else onStartHandoff();
    }}>
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
