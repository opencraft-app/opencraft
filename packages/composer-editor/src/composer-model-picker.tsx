import { DisclosureButton } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { ModelIcon, LightningIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { useRef, type ReactNode } from "react";
import type { useInputAuxiliaryMenuFocus } from "./use-input-auxiliary-menu-focus";

/** The same menu owns source browsing, model choices and supported controls. */
export function ComposerModelPicker({ policyRestricted, label, fullLabel, effortLabel, disabled, open, onOpenChange,
  portalContainer, focus, displayFast, children }: {
  readonly policyRestricted?: boolean;
  readonly label: string;
  readonly fullLabel: string;
  readonly effortLabel?: string;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly portalContainer?: HTMLElement | null;
  readonly focus: ReturnType<typeof useInputAuxiliaryMenuFocus>;
  readonly displayFast?: boolean;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  const content = useRef<HTMLDivElement | null>(null);
  const contentFocus = { ...focus.contentProps, onOpenAutoFocus(event: Event) {
    focus.contentProps.onOpenAutoFocus(event);
    if (!event.defaultPrevented) {
      event.preventDefault(); content.current?.querySelector<HTMLElement>('input[type="search"], [role="menuitem"]:not([data-disabled])')?.focus({ preventScroll: true });
    }
  } };
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
    <div className="opencraft-composer-picker opencraft-composer-picker--intelligence">
      <DropdownMenu.Trigger asChild>
        <DisclosureButton {...focus.triggerProps} className="opencraft-composer-mode opencraft-composer-mode--intelligence opencraft-composer-mode--depth"
          type="button" disabled={disabled} aria-label={fullLabel} title={fullLabel}>
          <ModelIcon className="opencraft-composer-mode__model-icon" size={16} aria-hidden="true" />
          <span className="opencraft-composer-mode__model-label">{label}</span>
          {effortLabel ? <span className="opencraft-composer-mode__effort-label">{effortLabel}</span> : null}
          {displayFast ? <LightningIcon className="opencraft-composer-mode__fast" size={14} filled aria-label={intl.formatMessage({ id: "composer.model.fastMode", defaultMessage: "Fast mode" })} /> : null}
        </DisclosureButton>
      </DropdownMenu.Trigger>
    </div>
    <DropdownMenu.Portal container={portalContainer}>
      <DropdownMenu.Content {...contentFocus} ref={node => { content.current = node; focus.contentProps.ref(node); }}
        className="opencraft-composer-selection-menu opencraft-composer-model-browser-surface"
        aria-label={intl.formatMessage({ id: "chat.model", defaultMessage: "Model" })}
        side="top" align="start" sideOffset={8} collisionPadding={12}
        onKeyDownCapture={event => { if (event.key === "Tab") event.stopPropagation(); }}>
        {children}
        {policyRestricted ? <div className="opencraft-composer-model-status__hint">{intl.formatMessage({ id: "modelPolicy.hint", defaultMessage: "Some options are disabled by your administrator." })}</div> : null}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
