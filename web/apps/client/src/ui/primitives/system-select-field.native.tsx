import ChevronDown from "lucide-react-native/icons/chevron-down";
import {useState} from "react";
import {Pressable, Text} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import {SystemSelect} from "./system-select.native";
import type {SystemSelectFieldProps} from "./system-select-field.types";

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
  const selected = options.find(option => option.value === value);
  return (
    <SystemSelect
      accessibilityLabel={accessibilityLabel}
      onChange={onChange}
      onOpenChange={setOpen}
      open={open}
      options={options}
      overlayId={overlayId}
      renderTrigger={({accessibilityControls, accessibilityExpanded, onPress}) => (
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="combobox"
          accessibilityState={{disabled, expanded: accessibilityExpanded}}
          aria-controls={accessibilityControls}
          disabled={disabled}
          onPress={onPress}
          style={({pressed}) => [
            styles.trigger,
            invalid && styles.invalid,
            pressed && styles.pressed,
            disabled && styles.disabled,
          ]}
          testID={testID}
        >
          <Text style={[styles.label, !selected && styles.placeholder]} numberOfLines={1}>
            {selected?.label ?? placeholder}
          </Text>
          <ChevronDown
            color={theme.semantic.color.iconSecondary}
            size={theme.semantic.icon.size.small}
            strokeWidth={theme.semantic.icon.stroke.regular}
          />
        </Pressable>
      )}
      value={value}
    />
  );
}

const styles = StyleSheet.create(theme => ({
  disabled: {opacity: theme.semantic.interaction.disabledOpacity},
  invalid: {borderColor: theme.semantic.color.borderDangerStrong},
  label: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.body,
  },
  placeholder: {color: theme.semantic.color.fieldPlaceholder},
  pressed: {backgroundColor: theme.semantic.color.interactivePressedSurface},
  trigger: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.control.fieldHeight,
    paddingHorizontal: theme.spacing.md,
  },
}));
