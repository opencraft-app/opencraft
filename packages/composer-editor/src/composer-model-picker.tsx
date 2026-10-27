import { DisclosureButton } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import type { DiscreteSliderOption } from "@opencraft/design-system-web/discrete-slider";
import { AnimatedContent } from "@opencraft/design-system-web/animated-content";
import { useIntl } from "@opencraft/i18n/react";
import { ModelIcon as BrainCircuit, ChevronRightIcon as ChevronRight, ResetIcon as RotateCcw, LightningIcon as Zap } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { useInputAuxiliaryMenuFocus } from "./use-input-auxiliary-menu-focus";

const loadPanel = () => import("./composer-model-panel");
const ComposerModelPanel = lazy(loadPanel);

/** Presentation only. Catalog, selection and remembered defaults retain their owners. */
export function ComposerModelPicker({ hasSelectedModel, label, modelLabel, fullLabel, effortLabel, disabled, open, onOpenChange, portalContainer, focus,
  efforts, effort, defaultEffort, onEffortChange, serviceTiers, serviceTier, displayFast, onServiceTierChange, children }: {
  readonly label: string;
  readonly hasSelectedModel: boolean;
  readonly modelLabel: string;
  readonly fullLabel: string;
  readonly effortLabel?: string;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly focus: ReturnType<typeof useInputAuxiliaryMenuFocus>;
  readonly efforts: readonly DiscreteSliderOption[];
  readonly effort: string | null;
  readonly defaultEffort: string | null;
  readonly onEffortChange: (value: string) => void;
  readonly serviceTiers: readonly { readonly id: string; readonly name: string; readonly description: string }[];
  readonly serviceTier: string | null;
  /** Snapshot indicator only; selectable tiers still come from the scoped catalog. */
  readonly displayFast?: boolean;
  readonly onServiceTierChange: (value: string | null) => void;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  // Keep the closing surface stable until Radix finishes its exit animation.
  // The next native opening resets the view before it becomes visible.
  const [modelsOpen, setModelsOpen] = useState(false);
  const showModels = modelsOpen || !hasSelectedModel;
  const quick = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (showModels && !focus.preservesEditorFocus()) {
      quick.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
    }
  }, [showModels]);
  const modelMenuLabel = intl.formatMessage({ id: "chat.model", defaultMessage: "Model" });
  const reasoningLabel = intl.formatMessage({ id: "chat.reasoning", defaultMessage: "Reasoning" });
  const fast = serviceTiers.find(tier => tier.id === "fast" || tier.name.toLowerCase() === "fast");
  const fastEnabled = !!fast && serviceTier === fast.id;
  const showFast = displayFast ?? fastEnabled;
  const triggerLabel = showFast ? `${fullLabel} · ${fast?.name ?? "Fast"}` : fullLabel;
  const resetLabel = intl.formatMessage({ id: "composer.resetEffort", defaultMessage: "Reset reasoning to model default" });
  const canReset = defaultEffort !== null && effort !== defaultEffort && efforts.some(option => option.value === defaultEffort);
  const title = (current?: string) => (
    <div className="opencraft-composer-model-quick__header">
      <div className="opencraft-composer-model-quick__action-slot">
        {fast ? <DropdownMenu.CheckboxItem className="opencraft-composer-model-quick__action opencraft-composer-model-quick__fast" aria-label={fast.name} title={fast.description || fast.name}
          checked={fastEnabled} onSelect={event => event.preventDefault()} onCheckedChange={checked => onServiceTierChange(checked ? fast.id : null)}>
          <Zap size={18} filled={fastEnabled} aria-hidden="true" />
        </DropdownMenu.CheckboxItem> : null}
      </div>
      <div className="opencraft-composer-model-quick__labels">
        {current ? <div className="opencraft-composer-model-quick__effort" title={current}><span key={current} className="opencraft-composer-model-quick__value">{current}</span></div> : null}
        <DropdownMenu.Item className="opencraft-composer-model-quick__title" title={modelLabel}
          onSelect={event => { event.preventDefault(); setModelsOpen(true); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown" && efforts.length > 1) {
              event.preventDefault(); event.stopPropagation();
              quick.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
            }
          }}>
          <span>{modelLabel}</span><ChevronRight size={14} aria-hidden="true" />
        </DropdownMenu.Item>
      </div>
      <div className="opencraft-composer-model-quick__action-slot">
        {efforts.length ? <DropdownMenu.Item className="opencraft-composer-model-quick__action opencraft-composer-model-quick__reset"
          aria-label={resetLabel} title={resetLabel} disabled={!canReset}
          onSelect={event => { event.preventDefault(); if (canReset) onEffortChange(defaultEffort!); }}>
          <RotateCcw size={18} aria-hidden="true" />
        </DropdownMenu.Item> : null}
      </div>
    </div>
  );
  return <>
    <DropdownMenu.Root open={open} onOpenChange={next => { if (next) setModelsOpen(!hasSelectedModel); onOpenChange(next); }}>
      <div className="opencraft-composer-picker opencraft-composer-picker--intelligence">
        <DropdownMenu.Trigger asChild>
          <DisclosureButton {...focus.triggerProps} className="opencraft-composer-mode opencraft-composer-mode--intelligence opencraft-composer-mode--depth"
            onPointerEnter={event => { if (event.pointerType !== "mouse") return; void loadPanel().catch(() => {}); }} onFocus={() => { void loadPanel().catch(() => {}); }}
            type="button" disabled={disabled} aria-label={triggerLabel} title={triggerLabel}>
            <BrainCircuit className="opencraft-composer-mode__model-icon" size={16} aria-hidden="true" />
            <span className="opencraft-composer-mode__model-label">{label}</span>
            {effortLabel ? <span className="opencraft-composer-mode__effort-label">{effortLabel}</span> : null}
            {showFast ? <Zap className="opencraft-composer-mode__fast" size={14} filled aria-label={fast?.name ?? "Fast"} /> : null}
          </DisclosureButton>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content {...focus.contentProps} ref={node => { quick.current = node; focus.contentProps.ref(node); }} className={`opencraft-composer-model-surface ${showModels ? "opencraft-composer-selection-menu opencraft-composer-selection-menu--model-select" : "opencraft-composer-model-quick"}`} aria-label={showModels ? modelMenuLabel : fullLabel}
          side="top" align="start" sideOffset={12} collisionPadding={12}>
          <AnimatedContent viewKey={showModels ? "models" : "effort"}>
          {showModels ? children : <Suspense fallback={<div aria-hidden="true">
            <div className="opencraft-composer-model-quick__header">
              <div className="opencraft-composer-model-quick__action-slot" />
              <div className="opencraft-composer-model-quick__labels">
                {effortLabel ? <div className="opencraft-composer-model-quick__effort">{effortLabel}</div> : null}
                <span className="opencraft-composer-model-quick__title">{modelLabel}</span>
              </div>
              <div className="opencraft-composer-model-quick__action-slot" />
            </div>
            {efforts.length ? <div className="opencraft-composer-model-quick__placeholder" /> : null}
          </div>}>
            <ComposerModelPanel efforts={efforts} effort={effort} defaultLabel={effortLabel} reasoningLabel={reasoningLabel}
              renderHeader={title} preservesEditorFocus={focus.preservesEditorFocus} onEffortChange={onEffortChange} />
          </Suspense>}
          </AnimatedContent>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </>;
}
