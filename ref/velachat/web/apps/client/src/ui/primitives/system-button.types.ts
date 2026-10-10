import type {LucideIcon} from "lucide-react-native";

export type SystemButtonVariant = "destructive" | "standard" | "toolbar";
export type SystemButtonVisualState = "focused" | "hovered" | "idle" | "pressed";

export interface SystemButtonProps {
  accessibilityLabel?: string;
  align?: "center" | "start" | "stretch";
  busy?: boolean;
  density?: "pointer" | "touch";
  disabled?: boolean;
  icon?: LucideIcon;
  iconTestID?: string;
  label: string;
  nativeID?: string;
  onPress(): void;
  testID?: string;
  variant?: SystemButtonVariant;
  /** Deterministic Style Lab / screenshot state; omit in product flows. */
  visualState?: SystemButtonVisualState;
}

export interface SystemIconButtonProps {
  accessibilityLabel: string;
  busy?: boolean;
  density?: "pointer" | "touch";
  disabled?: boolean;
  icon: LucideIcon;
  iconTestID?: string;
  nativeID?: string;
  onPress(): void;
  testID?: string;
  variant?: SystemButtonVariant;
  visualState?: SystemButtonVisualState;
}
