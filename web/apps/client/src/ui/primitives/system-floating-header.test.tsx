import {render} from "@testing-library/react-native";
import {Text} from "react-native";

import {velaTheme} from "../tokens";
import {SystemFloatingHeader} from "./system-floating-header";

describe("SystemFloatingHeader", () => {
  it("owns wide floating geometry without absolute positioning", async () => {
    const screen = await render(
      <SystemFloatingHeader layoutMode="wide" testID="wide-header">
        <Text>Channel</Text>
      </SystemFloatingHeader>,
    );

    expect(screen.getByTestId("wide-header-slot")).toHaveStyle({
      paddingBottom: velaTheme.spacing.md,
      paddingHorizontal: velaTheme.spacing.lg,
      paddingTop: velaTheme.spacing.md,
      position: "relative",
    });
    expect(screen.getByTestId("wide-header")).toHaveStyle({
      minHeight: velaTheme.recipes.desktopWorkspace.headerHeight,
      paddingHorizontal: velaTheme.spacing.xl,
      position: "relative",
      shadowColor: velaTheme.shadows.floatingControl.color,
    });
  });

  it("changes viewport insets without changing density-owned height", async () => {
    const screen = await render(
      <SystemFloatingHeader layoutMode="compact" testID="compact-header">
        <Text>Task</Text>
      </SystemFloatingHeader>,
    );

    expect(screen.getByTestId("compact-header-slot")).toHaveStyle({
      paddingBottom: velaTheme.spacing.sm,
      paddingHorizontal: velaTheme.spacing.sm,
      paddingTop: velaTheme.spacing.sm,
    });
    expect(screen.getByTestId("compact-header")).toHaveStyle({
      minHeight: velaTheme.recipes.desktopWorkspace.headerHeight,
      paddingHorizontal: velaTheme.spacing.md,
    });
  });

  it("keeps medium viewport layout on the desktop inset tier", async () => {
    const screen = await render(
      <SystemFloatingHeader layoutMode="medium" testID="medium-header">
        <Text>Members</Text>
      </SystemFloatingHeader>,
    );

    expect(screen.getByTestId("medium-header-slot")).toHaveStyle({
      paddingHorizontal: velaTheme.spacing.lg,
    });
  });

  it("is exported through the public UI boundary", () => {
    const ui = require("../index") as Record<string, unknown>;
    expect(ui.SystemFloatingHeader).toBe(SystemFloatingHeader);
  });

  it("applies consumer layout style only to the outer slot", async () => {
    const screen = await render(
      <SystemFloatingHeader
        layoutMode="wide"
        style={{alignSelf: "center", maxWidth: 960}}
        testID="styled-header"
      >
        <Text>Header</Text>
      </SystemFloatingHeader>,
    );

    expect(screen.getByTestId("styled-header-slot")).toHaveStyle({
      alignSelf: "center",
      maxWidth: 960,
    });
    expect(screen.getByTestId("styled-header")).not.toHaveStyle({maxWidth: 960});
  });
});
