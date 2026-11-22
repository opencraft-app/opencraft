import { lazy, Suspense } from "react";
import type { SettingsNavigationProps } from "./settings-page";

const SettingsNavigation = lazy(async () => {
  const module = await import("./settings-page");
  return { default: module.SettingsNavigation };
});

export function SettingsSidebarNavigation({
  section,
  choosingSection,
  managementOpen,
  ...props
}: Omit<SettingsNavigationProps, "section" | "presentation"> & {
  readonly section: string | null;
  readonly choosingSection: boolean;
  readonly managementOpen: boolean;
}) {
  const visibleSection = choosingSection ? "" : section;
  if (visibleSection === null) return null;

  return (
    <Suspense fallback={null}>
      <SettingsNavigation
        {...props}
        section={visibleSection}
        presentation={!choosingSection && managementOpen ? "dialog" : "sidebar"}
      />
    </Suspense>
  );
}
