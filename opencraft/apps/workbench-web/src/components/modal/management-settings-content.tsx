import type { ReactNode } from "react";

export interface ManagementSettingsContentProps {
  readonly children: ReactNode;
  readonly navigation: ReactNode;
}

/** Business-owned settings content slots; ModalHost owns the window. */
export function ManagementSettingsContent({
  children,
  navigation,
}: ManagementSettingsContentProps) {
  return (
    <>
      <aside className="management-settings-dialog__navigation">
        {navigation}
      </aside>
      <div className="management-settings-dialog__body">
        {children}
      </div>
    </>
  );
}
