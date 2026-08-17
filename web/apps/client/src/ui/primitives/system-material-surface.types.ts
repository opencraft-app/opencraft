import type {ReactNode} from "react";
import type {StyleProp, ViewStyle} from "react-native";

export type SystemMaterialRole =
  | "compactNavigation"
  | "composer"
  | "content"
  | "dialog"
  | "floatingHeader"
  | "floatingControl"
  | "navigationChrome"
  | "popover"
  | "toolbar";

export interface SystemMaterialSurfaceProps {
  children: ReactNode;
  materialRole: SystemMaterialRole;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}
