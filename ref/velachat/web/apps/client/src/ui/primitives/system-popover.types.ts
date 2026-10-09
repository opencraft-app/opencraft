import type {ReactNode} from "react";

import type {ControlledOverlayProps} from "./system-select.types";

export interface SystemPopoverProps extends ControlledOverlayProps {
  accessibilityLabel: string;
  children: ReactNode;
  initialFocusId?: string;
  placement?: "bottom start" | "right bottom";
  width?: number;
}
