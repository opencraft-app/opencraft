import { ModelIcon as BrainCircuit, CheckIcon as Check, ChevronDownIcon as ChevronDown, EditIcon as Pencil } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";

import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import type { ComposerModelOption, ComposerSelectionCatalog } from "./composer-editor";
import type { useInputAuxiliaryMenuFocus } from "./use-input-auxiliary-menu-focus";

export function groupComposerModels(models: readonly ComposerModelOption[], grouped: boolean) {
  const groups: Array<{ key: string; label: string | null; models: ComposerModelOption[] }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const model of models) {
    const key = grouped && model.groupKey && model.groupLabel ? model.groupKey : model.id;
    const label = grouped && model.groupKey && model.groupLabel ? model.groupLabel : null;
    let group = byKey.get(key);
    if (!group) { group = { key, label, models: [] }; groups.push(group); byKey.set(key, group); }
    group.models.push(model);
  }
  return groups;
}

/** Model-only session choice. Host reasoning and deployment defaults remain external. */
export function SessionModelPicker({ catalog, label, selected, disabled, open, onOpenChange, onSelect, portalContainer, focus }: {
  readonly catalog?: ComposerSelectionCatalog;
  readonly label: string;
  readonly selected: string | null;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (model: ComposerModelOption) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly focus: ReturnType<typeof useInputAuxiliaryMenuFocus>;
}) {
  const intl = useIntl();
  const models = catalog?.models ?? [];
  const groups = groupComposerModels(models, true);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const element = labelRef.current;
    if (!element) return;
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [label]);
  const failedLabel = intl.formatMessage({ id: "composer.model.loadError", defaultMessage: "Couldn't load models. Try again." });
  return <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
    <div className="opencraft-composer-picker opencraft-composer-picker--intelligence">
      <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
        <Tooltip.Root open={truncated && !open ? undefined : false}>
          <Tooltip.Trigger asChild><DropdownMenu.Trigger asChild>
            <button {...focus.triggerProps} className="opencraft-composer-mode opencraft-composer-mode--intelligence" type="button" disabled={disabled}
              aria-label={label} title={catalog?.modelError ? failedLabel : undefined}>
              <BrainCircuit className="opencraft-composer-mode__model-icon" size={16} aria-hidden="true" />
              <span ref={labelRef} className="opencraft-composer-mode__model-label">{models.length === 0 && !catalog?.modelError
                ? <span className="opencraft-composer-mode__model-skeleton" aria-hidden="true" /> : label}</span>
              <ChevronDown className="opencraft-composer-mode__chevron" size={12} />
            </button>
          </DropdownMenu.Trigger></Tooltip.Trigger>
          <Tooltip.Portal container={portalContainer ?? undefined}><Tooltip.Content className="opencraft-composer-model-name-tooltip" side="top" sideOffset={8} collisionPadding={8}>
            {label}<Tooltip.Arrow className="opencraft-composer-model-name-tooltip__arrow" width={10} height={6} />
          </Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content {...focus.contentProps} className="opencraft-composer-selection-menu opencraft-composer-selection-menu--intelligence"
          data-has-detail="false" data-model-groups={groups.some(group => group.label !== null) ? "true" : undefined}
          data-configure-models={catalog?.onConfigureModels ? "true" : undefined}
          aria-label={intl.formatMessage({ id: "chat.model", defaultMessage: "Model" })} align="start" sideOffset={6} collisionPadding={6}>
          <div className="opencraft-composer-intelligence-view"><div className="opencraft-composer-intelligence-models">
            {groups.map(group => {
              const items = group.models.map(model => {
                const isSelected = model.value === selected || model.id === selected;
                return <DropdownMenu.Item key={model.id} className={`opencraft-composer-selection-menu__item ${group.label === null ? "is-root-model" : "is-nested-model"}`}
                  data-selected={isSelected ? "true" : undefined} onSelect={() => onSelect(model)}>
                  <span className="opencraft-composer-selection-menu__copy"><span className="opencraft-composer-selection-menu__label"><span className="opencraft-composer-model-label-with-role">
                    <span className="opencraft-composer-model-label-with-role__name">{model.label}</span>
                    {model.configuredRole === "fallback" ? <span className="opencraft-composer-model-role" data-role="fallback"><FormattedMessage id="composer.model.fallbackShort" defaultMessage="Backup" /></span> : null}
                  </span></span></span>{isSelected ? <span className="opencraft-composer-selection-menu__trailing" aria-hidden="true"><Check size={16} /></span> : null}
                </DropdownMenu.Item>;
              });
              return group.label === null ? <Fragment key={group.key}>{items}</Fragment> : <DropdownMenu.Group key={group.key}>
                <DropdownMenu.Label className="opencraft-composer-model-group__label">{group.label}</DropdownMenu.Label>{items}
              </DropdownMenu.Group>;
            })}
            {catalog?.isFetching ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.model.loading" defaultMessage="Loading models…" /></div> : null}
            {catalog?.modelError ? <div className="opencraft-composer-selection-menu__status is-error">{failedLabel}
              {catalog.retryModels ? <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={event => { event.preventDefault(); catalog.retryModels?.(); }}><FormattedMessage id="composer.model.retry" defaultMessage="Retry" /></DropdownMenu.Item> : null}
            </div> : null}
            {!catalog?.isFetching && !catalog?.modelError && models.length === 0 ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.model.empty" defaultMessage="No models available. Check Model Settings." /></div> : null}
            {!catalog?.isFetching && !catalog?.modelError && models.length > 0 && selected !== null && !models.some(model => model.value === selected || model.id === selected)
              ? <div className="opencraft-composer-selection-menu__status is-error"><FormattedMessage id="composer.model.unavailable" defaultMessage="The selected model is unavailable. Choose another model." /></div> : null}
          </div></div>
          {catalog?.onConfigureModels ? <div className="opencraft-composer-model-configure-footer"><DropdownMenu.Separator className="opencraft-composer-selection-menu__separator" />
            <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureModels}><Pencil size={16} aria-hidden="true" /><FormattedMessage id="composer.model.configure" defaultMessage="Add more models" /></DropdownMenu.Item>
          </div> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </div>
  </DropdownMenu.Root>;
}
