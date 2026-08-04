import type {ChangeEvent, CSSProperties} from "react";
import {
  StyleSheet as NativeStyleSheet,
  type StyleProp,
  type TextStyle,
} from "react-native";

export interface LocalDateTimeInputProps {
  accessibilityLabel: string;
  disabled?: boolean;
  onChangeText(value: string): void;
  placeholder?: string;
  style?: StyleProp<TextStyle>;
  value: string;
}

export function LocalDateTimeInput({
  accessibilityLabel,
  disabled = false,
  onChangeText,
  placeholder,
  style,
  value,
}: LocalDateTimeInputProps) {
  return (
    <input
      aria-label={accessibilityLabel}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChangeText(event.target.value)
      }
      placeholder={placeholder}
      style={NativeStyleSheet.flatten(style) as CSSProperties}
      type="datetime-local"
      value={value}
    />
  );
}
