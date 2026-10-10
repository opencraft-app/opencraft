import {
  visibleSectionPresentationItems,
  workspaceSectionLabel,
} from "./section-navigation-model";

describe("terminal-safe section navigation model", () => {
  it("exposes labels and management visibility without graphical icons", () => {
    expect(visibleSectionPresentationItems(false).map((item) => item.id)).toEqual([
      "chat",
      "tasks",
      "agents",
      "computers",
      "members",
    ]);
    expect(visibleSectionPresentationItems(true).at(-1)).toEqual({
      accessibilityLabel: "打开 Server 设置",
      id: "settings",
      label: "设置",
    });
    expect(workspaceSectionLabel("agents")).toBe("Agent");
  });
});
