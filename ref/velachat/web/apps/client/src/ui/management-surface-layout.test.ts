import {managementSurfaceLayout} from "./management-surface-layout";
import {breakpoints, workspaceShellWideBreakpoint} from "./tokens";

describe("managementSurfaceLayout", () => {
  it("stacks the collection whenever chrome is compact", () => {
    expect(managementSurfaceLayout(workspaceShellWideBreakpoint - 1)).toEqual({
      chromeMode: "compact",
      density: "medium",
      phone: false,
      stackedCollection: true,
    });
  });

  it("keeps a vertical collection once the rail can sit beside content", () => {
    // 960 opens the rail (chrome medium until the 1180 content band).
    expect(managementSurfaceLayout(workspaceShellWideBreakpoint)).toEqual({
      chromeMode: "medium",
      density: "medium",
      phone: false,
      stackedCollection: false,
    });
    expect(managementSurfaceLayout(breakpoints.wide)).toEqual({
      chromeMode: "wide",
      density: "comfortable",
      phone: false,
      stackedCollection: false,
    });
  });

  it("uses phone density under the medium breakpoint", () => {
    expect(managementSurfaceLayout(breakpoints.medium - 1).phone).toBe(true);
    expect(managementSurfaceLayout(breakpoints.medium - 1).density).toBe(
      "compact",
    );
  });
});
