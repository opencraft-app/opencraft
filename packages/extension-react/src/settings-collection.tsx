import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { SettingsPanel } from "./settings-panel";
import { SettingsNavigationRow, SettingsSection } from "./settings-controls";
import "./settings-collection.scss";

/** Route content for the host Header region. The host retains navigation and safe areas. */
export function SettingsCollectionToolbar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <div className="settings-collection-toolbar"><h2>{title}</h2>{actions}</div>;
}

/** Utility panel with explicit in-flow actions instead of an overlaid close button. */
export function SettingsCollectionPanel(props: ComponentProps<typeof SettingsPanel>) {
  return <div className="settings-collection-panel"><SettingsPanel {...props} /></div>;
}

/** Opt-in grouped collection; does not restyle ordinary Settings forms. */
export function SettingsCollection({ className, appearance = "grouped", ...props }: HTMLAttributes<HTMLDivElement> & { appearance?: "grouped" | "list" }) {
  return <div {...props} data-collection-appearance={appearance} className={["settings-collection", className].filter(Boolean).join(" ")} />;
}
export function SettingsCollectionSection(props: ComponentProps<typeof SettingsSection>) {
  return <SettingsSection {...props} className={["settings-collection-section", props.className].filter(Boolean).join(" ")} />;
}
export function SettingsCollectionFooter({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={["settings-collection-footer", className].filter(Boolean).join(" ")} />;
}

/** One native button, using the existing Settings navigation/focus/hit-area owner.
 * Label and description are non-interactive content; never nest action controls. */
export function SettingsCollectionRow({ label, description, icon, ...props }: Omit<ComponentProps<typeof SettingsNavigationRow>, "label" | "tone"> & {
  label: ReactNode; description?: ReactNode; icon?: ReactNode;
}) {
  return <SettingsNavigationRow {...props} className={["settings-collection-row", props.className].filter(Boolean).join(" ")} label={<>
    {icon === undefined ? null : <span className="settings-collection-row__icon" aria-hidden="true">{icon}</span>}
    <span className="settings-collection-row__copy"><span>{label}</span>{description === undefined ? null : <small>{description}</small>}</span>
  </>} />;
}

/** Scroll and reading geometry for resource catalogs; Shell retains its Header. */
export function SettingsCollectionDocument({ children, className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={["settings-collection-document", className].filter(Boolean).join(" ")}>
    <div className="settings-collection-document__content">{children}</div>
  </div>;
}
/** Categories stay beside actions; wrap whole groups when container capacity requires it. */
export function SettingsCollectionNavigation({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="settings-collection-navigation">{children}<div className="settings-collection-navigation__actions">{actions}</div></div>;
}
