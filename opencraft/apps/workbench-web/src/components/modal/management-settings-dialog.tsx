import type { ReactNode } from "react";

import { ModalSurface } from "./modal-surface";

export interface ManagementSettingsDialogProps {
  readonly children: ReactNode;
  readonly navigation: ReactNode;
  readonly onClose: () => void;
  readonly title?: string;
}

/** Hermes settings content composed into the platform-owned modal adapter. */
export function ManagementSettingsDialog({
  children,
  navigation,
  onClose,
  title = "Agent settings",
}: ManagementSettingsDialogProps) {
  return (
    <ModalSurface
      className="management-settings-dialog"
      label={title}
      onDismiss={onClose}
    >
      <aside className="management-settings-dialog__navigation">
        {navigation}
      </aside>
      <div className="management-settings-dialog__body">
        {children}
      </div>
    </ModalSurface>
  );
}
