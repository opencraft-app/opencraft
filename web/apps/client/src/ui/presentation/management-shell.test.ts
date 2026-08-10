import {buildManagementShellModel} from "./management-shell";
import {sectionNavigation} from "../layouts/workspace-section";

describe("buildManagementShellModel", () => {
  it("mirrors visibleSectionNavigation labels and membership", () => {
    const navigated: string[] = [];
    const withoutSettings = buildManagementShellModel({
      activeSection: "agents",
      canManageServer: false,
      currentServerId: "s1",
      onNavigateSection: section => {
        navigated.push(section);
      },
      onSelectServer: () => undefined,
      servers: [{id: "s1", name: "Alpha", slug: "alpha"} as never],
    });

    expect(withoutSettings.navigation.map(item => item.label)).toEqual(
      sectionNavigation
        .filter(item => item.id !== "settings")
        .map(item => item.label),
    );
    expect(
      withoutSettings.navigation.some(item => item.id === "navigate-settings"),
    ).toBe(false);

    const withSettings = buildManagementShellModel({
      activeSection: "settings",
      canManageServer: true,
      currentServerId: "s1",
      onNavigateSection: () => undefined,
      onSelectServer: () => undefined,
      servers: [{id: "s1", name: "Alpha", slug: "alpha"} as never],
    });
    expect(
      withSettings.navigation.some(item => item.id === "navigate-settings"),
    ).toBe(true);

    withoutSettings.navigation[0]?.run();
    expect(navigated).toEqual(["chat"]);
  });
});
