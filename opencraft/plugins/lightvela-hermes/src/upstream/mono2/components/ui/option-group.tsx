import type { FieldsetHTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/utils";

export interface OptionGroupItem<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  readonly describedBy?: string;
}

export interface OptionGroupProps<Value extends string>
  extends Omit<FieldsetHTMLAttributes<HTMLFieldSetElement>, "onChange"> {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: Value;
  readonly options: readonly OptionGroupItem<Value>[];
  readonly onValueChange: (value: Value) => void;
  readonly optionsClassName?: string;
  readonly help?: ReactNode;
}

/**
 * Token-driven single-choice primitive. Feature pages own values and policy;
 * the host theme owns radio, card, focus, selected and disabled presentation.
 */
export function OptionGroup<Value extends string>({
  label,
  name,
  value,
  options,
  onValueChange,
  optionsClassName,
  help,
  className,
  ...props
}: OptionGroupProps<Value>) {
  return (
    <fieldset {...props} className={cn("lv-option-group", className)}>
      <legend className="lv-option-group__legend">{label}</legend>
      <div className={cn("lv-option-group__options", optionsClassName)}>
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className="lv-option"
              data-state={selected ? "checked" : "unchecked"}
              data-disabled={option.disabled ? "true" : undefined}
            >
              <input
                type="radio"
                className="lv-radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={option.disabled}
                aria-describedby={option.describedBy}
                onChange={() => onValueChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
      {help}
    </fieldset>
  );
}
