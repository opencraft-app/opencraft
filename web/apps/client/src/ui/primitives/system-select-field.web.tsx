import type {FocusEvent, Ref} from "react";
import {useState} from "react";
import {useUnistyles} from "react-native-unistyles";

import {SystemSelect} from "./system-select.web";
import type {SystemSelectFieldProps} from "./system-select-field.types";
import {webTypography} from "./web-typography";

export type {SystemSelectFieldProps} from "./system-select-field.types";

export function SystemSelectField<T extends string>({
  accessibilityLabel,
  disabled = false,
  invalid = false,
  onChange,
  options,
  overlayId,
  placeholder = "请选择",
  testID,
  value,
}: SystemSelectFieldProps<T>) {
  const {theme} = useUnistyles();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const selected = options.find(option => option.value === value);

  return (
    <SystemSelect
      accessibilityLabel={accessibilityLabel}
      onChange={onChange}
      onOpenChange={setOpen}
      open={open}
      options={options}
      overlayId={overlayId}
      renderTrigger={({accessibilityControls, accessibilityExpanded, onPress, ref}) => (
        <button
          aria-controls={accessibilityControls}
          aria-expanded={accessibilityExpanded}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-label={accessibilityLabel}
          data-testid={testID}
          disabled={disabled}
          onBlur={() => setFocusVisible(false)}
          onClick={onPress}
          onFocus={(event: FocusEvent<HTMLButtonElement>) => {
            setFocusVisible(event.currentTarget.matches(":focus-visible"));
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          ref={ref as Ref<HTMLButtonElement>}
          role="combobox"
          style={{
            ...webTypography(theme.semantic.typography.body),
            alignItems: "center",
            appearance: "none",
            background: theme.semantic.color.fieldSurface,
            borderColor: focusVisible
              ? theme.semantic.color.borderFocus
              : invalid
                ? theme.semantic.color.borderDangerStrong
                : hovered
                  ? theme.semantic.color.borderFieldHover
                  : theme.semantic.color.borderControl,
            borderRadius: theme.semantic.radius.control,
            borderStyle: "solid",
            borderWidth: theme.semantic.stroke.hairline,
            boxShadow: focusVisible
              ? `0 0 0 3px ${theme.semantic.color.fieldFocusGlow}`
              : "none",
            boxSizing: "border-box",
            color: selected
              ? theme.semantic.color.textPrimary
              : theme.semantic.color.fieldPlaceholder,
            cursor: disabled ? "not-allowed" : "pointer",
            display: "flex",
            gap: theme.spacing.sm,
            height: theme.recipes.control.fieldHeight,
            justifyContent: "space-between",
            opacity: disabled ? theme.semantic.interaction.disabledOpacity : 1,
            outline: "none",
            padding: `0 ${theme.spacing.md}px`,
            textAlign: "left",
            width: "100%",
            ...theme.semantic.motion.transition.control,
          }}
          type="button"
        >
          <span style={{flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis"}}>
            {selected?.label ?? placeholder}
          </span>
          <span
            aria-hidden
            style={{
              borderBottom: `${theme.semantic.stroke.hairline}px solid currentColor`,
              borderRight: `${theme.semantic.stroke.hairline}px solid currentColor`,
              flex: "0 0 auto",
              height: 7,
              marginBottom: theme.spacing.xs,
              transform: accessibilityExpanded ? "rotate(225deg)" : "rotate(45deg)",
              width: 7,
              ...theme.semantic.motion.transition.control,
            }}
          />
        </button>
      )}
      value={value}
    />
  );
}
