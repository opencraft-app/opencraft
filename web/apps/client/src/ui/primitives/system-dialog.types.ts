import type {ReactNode} from "react";

export type DialogCloseReason =
  | "action"
  | "backdrop"
  | "cancel"
  | "escape"
  | "nativeBack";

export interface SystemDialogAction {
  disabled?: boolean;
  id: string;
  intent: "default" | "destructive" | "secondary";
  kind: "action" | "cancel";
  label: string;
}

export interface SystemDialogProps {
  actions: readonly SystemDialogAction[];
  atomicLock?: boolean;
  busy?: boolean;
  children?: ReactNode;
  description: string;
  dialogId: string;
  dismissOnBackdrop?: boolean;
  initialFocusId?: string;
  onAction(id: string): void;
  onOpenChange(open: false, reason: DialogCloseReason): void;
  open: boolean;
  title: string;
  urgency?: "normal" | "urgent";
}
