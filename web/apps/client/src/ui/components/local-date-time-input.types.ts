import type {StyleProp, TextStyle} from "react-native";

export interface LocalDateTimePreset {
  id: string;
  label: string;
  value: string;
}

export interface LocalDateTimeInputConfig {
  maxValue?: string;
  minValue?: string;
  minuteStep?: number;
  presets?: readonly LocalDateTimePreset[];
  timezone?: string;
}

export interface LocalDateTimeInputProps extends LocalDateTimeInputConfig {
  accessibilityLabel: string;
  disabled?: boolean;
  onChangeText(value: string): void;
  placeholder?: string;
  style?: StyleProp<TextStyle>;
  value: string;
}
