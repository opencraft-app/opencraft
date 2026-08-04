import {
  TextInput,
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
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoCapitalize="none"
      editable={!disabled}
      onChangeText={onChangeText}
      placeholder={placeholder}
      style={style}
      value={value}
    />
  );
}
