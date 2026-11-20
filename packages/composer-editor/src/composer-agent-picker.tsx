import { useRef } from "react";
import { DisclosureButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon, AgentIcon, CheckIcon, ChevronDownIcon, ModelIcon } from "@opencraft/design-system-web/action-icons";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { composerAgentSources } from "./composer-agent-sources";
import type { ComposerAgentModelGroup, ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";
import type { useInputAuxiliaryMenuFocus } from "./use-input-auxiliary-menu-focus";

/** Presentation only: the Composer's existing model-selection transaction commits. */
export function ComposerAgentPicker({ catalog, selected, displayModel, disabled, open, onOpenChange, portalContainer, focus, onSelect }: {
  catalog?: ComposerSelectionCatalog;
  selected: string | null;
  displayModel: ComposerModelOption | null;
  disabled: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  portalContainer?: HTMLElement | null;
  focus: ReturnType<typeof useInputAuxiliaryMenuFocus>;
  onSelect(model: ComposerModelOption, group?: ComposerAgentModelGroup): void;
}) {
  const intl = useIntl();
  const trigger = useRef<HTMLButtonElement>(null);
  const sources = composerAgentSources(catalog, intl);
  const multiMachine = new Set(sources.map(source => source.group.machineId ?? source.group.id)).size > 1 && sources.some(source => Boolean(source.group.machineLabel));
  const current = sources.find(source => source.group.active && source.models.some(model => model.value === selected || model.id === selected));
  const manageModels = catalog?.agentGroups?.find(group => group.active)?.manage ?? catalog?.onConfigureModels;
  const hasApiModels = sources.some(source => source.id.endsWith(":dsh") || source.id.endsWith(":api"));
  return <Menu.Root open={open} onOpenChange={onOpenChange}>
    <Menu.Trigger asChild>
      <DisclosureButton ref={trigger} {...focus.triggerProps} className="opencraft-composer-picker opencraft-composer-agent-trigger" disabled={disabled}
        aria-label={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}>
        {current?.brand ? <AgentBrandIcon agent={current.brand} size={15} /> : <AgentIcon size={15} aria-hidden="true" />}
        <span>{current?.models[0]?.agentLabel ?? current?.agentLabel ?? displayModel?.agentLabel ?? intl.formatMessage({ id: "composer.agent.choose", defaultMessage: "Choose Agent" })}</span>
        <ChevronDownIcon size={12} aria-hidden="true" />
      </DisclosureButton>
    </Menu.Trigger>
    <Menu.Portal container={portalContainer}>
      <Menu.Content {...focus.contentProps} className="opencraft-composer-selection-menu" side="top" align="start" sideOffset={8} collisionPadding={12}
        onPointerDownOutside={event => {
          // The trigger owns toggling, including a reopening before the previous
          // menu finishes closing. Its old outside listener must not dismiss it.
          if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault();
        }}>
        {!multiMachine ? <Menu.Label className="opencraft-composer-selection-menu__heading"><FormattedMessage id="composer.agent.label" defaultMessage="Agent" /></Menu.Label> : null}
        {sources.map((source, index) => {
          const prevMachine = index > 0 ? (sources[index - 1]!.group.machineId ?? sources[index - 1]!.group.id) : null;
          const machineKey = source.group.machineId ?? source.group.id;
          const showHeading = multiMachine && machineKey !== prevMachine;
          const available = source.models.filter(model => !model.policyRestricted);
          const model = available.find(model => model.value === selected || model.id === selected) ?? available.find(model => model.isDefault) ?? available[0];
          return <div key={source.id} style={{ display: "contents" }}>
            {showHeading ? <Menu.Label className="opencraft-composer-selection-menu__heading">{source.group.machineLabel || source.group.label}</Menu.Label> : null}
            <Menu.Item className="opencraft-composer-selection-menu__item" disabled={!model}
              data-selected={source === current || undefined} onSelect={() => {
                if (model && source !== current) onSelect(model, source.group.select ? source.group as ComposerAgentModelGroup : undefined);
              }}>
              {source.brand ? <AgentBrandIcon agent={source.brand} size={16} /> : <AgentIcon size={16} aria-hidden="true" />}
              <span className="opencraft-composer-selection-menu__copy">{source.models[0]?.agentLabel ?? source.agentLabel}</span>
              {source === current ? <CheckIcon size={16} aria-hidden="true" /> : null}
            </Menu.Item>
          </div>;
        })}
        {catalog?.isFetching && !sources.length ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.agent.loading" defaultMessage="Loading agents…" /></div> : null}
        {!catalog?.isFetching && !sources.length ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.agent.none" defaultMessage="No enabled agents have available models. Enable an agent or check its setup in settings." /></div> : null}
        {catalog?.retryModels && catalog.modelError ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.retryModels}><FormattedMessage id="welcome.retry" defaultMessage="Retry" /></Menu.Item> : null}
        {!hasApiModels && manageModels ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={manageModels}><ModelIcon size={16} aria-hidden="true" /><FormattedMessage id="composer.model.add" defaultMessage="Add a model…" /></Menu.Item> : null}
        {catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
