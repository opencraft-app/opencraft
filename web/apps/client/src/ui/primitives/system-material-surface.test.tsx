import {render} from "@testing-library/react-native";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Text} from "react-native";

import {velaTheme} from "../tokens";
import {SystemWindowStateProvider} from "../system-window-state";

const sharedPath = join(__dirname, "system-material-surface.tsx");
const webPath = join(__dirname, "system-material-surface.web.tsx");
const nativePath = join(__dirname, "system-material-surface.native.tsx");

describe("Tahoe material surfaces", () => {
  it("provides matching shared, Web and Native material modules", () => {
    expect([sharedPath, webPath, nativePath].every(existsSync)).toBe(true);
  });

  it("keeps content opaque while navigation owns one Web backdrop", async () => {
    if (!existsSync(webPath)) return;
    const {SystemMaterialSurface} = require(
      "./system-material-surface.web"
    ) as typeof import("./system-material-surface.web");
    const screen = await render(
      <>
        <SystemMaterialSurface materialRole="navigationChrome" testID="navigation-material">
          <Text>navigation</Text>
        </SystemMaterialSurface>
        <SystemMaterialSurface materialRole="content" testID="content-material">
          <Text>content</Text>
        </SystemMaterialSurface>
      </>,
    );

    expect(screen.getByTestId("navigation-material")).toHaveStyle(
      {
        backdropFilter: velaTheme.semantic.material.blur,
        backgroundColor: velaTheme.semantic.material.navigationFill,
      } as never,
    );
    expect(screen.getByTestId("content-material")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.paneSurface,
    });
    expect(screen.getByTestId("navigation-material").props.dataSet).toEqual({
      velaMaterial: "navigationChrome",
    });
  });

  it("dims chrome, but not document content, when the host window is inactive", async () => {
    const {SystemMaterialSurface} = require(
      "./system-material-surface.web"
    ) as typeof import("./system-material-surface.web");
    const screen = await render(
      <SystemWindowStateProvider forcedActive={false}>
        <SystemMaterialSurface materialRole="navigationChrome" testID="inactive-navigation">
          <Text>navigation</Text>
        </SystemMaterialSurface>
        <SystemMaterialSurface materialRole="content" testID="inactive-content">
          <Text>content</Text>
        </SystemMaterialSurface>
      </SystemWindowStateProvider>,
    );

    expect(screen.getByTestId("inactive-navigation")).toHaveStyle({
      backgroundColor: velaTheme.semantic.material.navigationInactiveFill,
    });
    expect(screen.getByTestId("inactive-content")).not.toHaveStyle({
      backgroundColor: velaTheme.semantic.material.navigationInactiveFill,
    });
  });

  it("provides system fallbacks for forced colors and reduced transparency", () => {
    const focusInstaller = readFileSync(
      join(__dirname, "..", "focus-ring.web.ts"),
      "utf8",
    );

    expect(focusInstaller).toContain("forced-colors: active");
    expect(focusInstaller).toContain("prefers-reduced-transparency: reduce");
    expect(focusInstaller).toContain("[data-vela-material]");
  });

  it("gives PlatformFrame the only desktop navigation backdrop owner", () => {
    const appFrame = readFileSync(
      join(__dirname, "..", "layouts", "app-frame.tsx"),
      "utf8",
    );
    const shellStyles = readFileSync(
      join(__dirname, "..", "layouts", "workspace-shell.styles.ts"),
      "utf8",
    );
    const managementStyles = readFileSync(
      join(__dirname, "..", "components", "management-workspace.styles.ts"),
      "utf8",
    );

    expect(appFrame).toContain('materialRole="navigationChrome"');
    expect(appFrame).toContain('testID="navigation-chrome"');
    expect(styleBlock(appFrame, "serverRail")).not.toContain("backdropFilter");
    expect(styleBlock(shellStyles, "conversationSidebar")).not.toContain("backdropFilter");
    expect(styleBlock(managementStyles, "collectionPane")).not.toContain("backdropFilter");
  });
});

function styleBlock(source: string, name: string): string {
  return new RegExp(`^ {2}${name}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "mu")
    .exec(source)?.[1] ?? "";
}
