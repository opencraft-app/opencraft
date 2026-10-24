import { CheckIcon as Check, ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { LaptopIcon as Laptop, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";

import type { PlatformToolbarSelectProps } from "@opencraft/extension-react";

import { Button } from "./ui/button";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

function optionVisual(visual: "local" | "remote" | undefined) {
  if (visual === "local") return <Laptop aria-hidden="true" />;
  if (visual === "remote") return <Server aria-hidden="true" />;
  return null;
}

export function AppShellToolbarSelect({
  value,
  options,
  onValueChange,
  label,
  title = "Host",
  placeholder = "Select",
  disabled = false,
}: PlatformToolbarSelectProps) {
  const portalContainer = useWorkbenchPresentationRoot();
  const selected = options.find((option) => option.value === value) ?? null;
  const unavailable = disabled || options.length === 0;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild disabled={unavailable}>
        <Button
          aria-label={label}
          className="app-shell-toolbar-select"
          disabled={unavailable}
          size="toolbar"
          variant="secondary"
        >
          {optionVisual(selected?.visual)}
          <span className="app-shell-toolbar-select__label">{selected?.label ?? placeholder}</span>
          <ChevronDown aria-hidden="true" className="app-shell-toolbar-select__chevron" data-toolbar-chevron />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer}>
        <DropdownMenu.Content
          align="end"
          aria-label={label}
          className="app-shell-toolbar-menu"
          collisionPadding={6}
          sideOffset={1}
        >
          <DropdownMenu.Label className="app-shell-toolbar-menu__title">{title}</DropdownMenu.Label>
          <DropdownMenu.Group className="app-shell-toolbar-menu__section">
            {options.map((option) => (
              <DropdownMenu.Item
                className="app-shell-toolbar-menu__item"
                disabled={option.disabled}
                key={option.value}
                onSelect={() => onValueChange(option.value)}
                textValue={option.textValue}
              >
                <span className="app-shell-toolbar-menu__item-content">
                  {optionVisual(option.visual)}
                  <span>{option.label}</span>
                </span>
                {option.value === value ? (
                  <Check aria-hidden="true" className="app-shell-toolbar-menu__check" />
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
