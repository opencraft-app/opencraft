import { useEffect, useState } from "react";
import { Button } from "./button";
import { CheckIcon, ChevronDownIcon } from "./action-icons";
import * as Menu from "./dropdown-menu";

export interface ChoiceSelectOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

/** A themed single choice. The shared Radix menu owns focus, keys and touch dismissal. */
export function ChoiceSelect<Value extends string>({ id, label, value, options, onValueChange, disabled = false, placeholder }: {
  readonly id?: string;
  readonly label: string;
  readonly value: Value;
  readonly options: readonly ChoiceSelectOption<Value>[];
  readonly onValueChange: (value: Value) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const unavailable = disabled || options.length === 0;
  useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
  const selected = options.find(option => option.value === value);
  return <Menu.Root open={open && !unavailable} onOpenChange={setOpen}>
    <Menu.Trigger asChild disabled={unavailable}>
      <Button id={id} className="ui-choice-select__trigger" variant="outline" size="sm" contentLayout="row" aria-label={label} disabled={unavailable}>
        <span className="ui-choice-select__value">{selected?.label ?? placeholder ?? label}</span>
        <ChevronDownIcon size={16} aria-hidden="true" />
      </Button>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="ui-choice-select__menu" align="end" sideOffset={6} collisionPadding={8} aria-label={label}>
        <Menu.RadioGroup className="ui-choice-select__list" value={value} onValueChange={next => {
          const option = options.find(option => option.value === next && !option.disabled);
          if (!unavailable && option && option.value !== value) onValueChange(option.value);
        }}>
          {options.map(option => <Menu.RadioItem key={option.value} value={option.value} disabled={option.disabled} textValue={option.label} className="ui-choice-select__option">
            <span>{option.label}</span>
            <span className="ui-choice-select__check"><Menu.ItemIndicator><CheckIcon size={14} aria-hidden="true" /></Menu.ItemIndicator></span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
