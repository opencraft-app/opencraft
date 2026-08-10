import type {SystemSelectOption} from "./system-select.types";

export interface SystemSelectFieldProps<T extends string> {
  accessibilityLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange(value: T): void;
  options: readonly SystemSelectOption<T>[];
  overlayId: string;
  placeholder?: string;
  testID?: string;
  value: T | null;
}
