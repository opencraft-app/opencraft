import {
  TextInput,
} from "react-native";

import type {LocalDateTimeInputProps} from "./local-date-time-input.types";

export type {
  LocalDateTimeInputConfig,
  LocalDateTimeInputProps,
  LocalDateTimePreset,
} from "./local-date-time-input.types";

export function LocalDateTimeInput({
  accessibilityLabel,
  disabled = false,
  onChangeText,
  placeholder,
  style,
  timezone,
  value,
}: LocalDateTimeInputProps) {
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={timezone ? `时区 ${timezone}` : undefined}
      autoCapitalize="none"
      editable={!disabled}
      onChangeText={onChangeText}
      placeholder={placeholder}
      style={style}
      value={value}
    />
  );
}
