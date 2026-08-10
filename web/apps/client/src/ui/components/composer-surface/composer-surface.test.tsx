import {render} from "@testing-library/react-native";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {Text} from "react-native";

import {velaTheme} from "../../tokens";
import {
  ComposerFooter,
  ComposerStage,
  ComposerSurfaceLayout,
} from ".";
import {ComposerFooter as NativeComposerFooter} from "./composer-footer.native";
import {ComposerMaterialSurface as NativeComposerMaterialSurface} from "./composer-material-surface.native";
import {shouldForwardComposerSurfacePress} from "./composer-material-surface.web";

describe("integrated composer surface", () => {
  it("owns the shared desktop axis", async () => {
    const desktop = await render(
      <ComposerStage surfaceMode="desktop">
        <Text>desktop</Text>
      </ComposerStage>,
    );
    expect(desktop.getByTestId("composer-stage")).toHaveStyle({
      maxWidth:
        velaTheme.recipes.conversationWorkspace.composerDesktopMaxWidth,
      width: "100%",
    });
  });

  it.each(["compact", "native"] as const)(
    "keeps the %s stage full width",
    async (surfaceMode) => {
      const screen = await render(
        <ComposerStage surfaceMode={surfaceMode}>
          <Text>{surfaceMode}</Text>
        </ComposerStage>,
      );
      expect(screen.getByTestId("composer-stage")).toHaveStyle({
        maxWidth: "100%",
        width: "100%",
      });
    },
  );

  it("keeps quote, attachments, editor, error and footer in one surface layout", async () => {
    const screen = await render(
      <ComposerSurfaceLayout
        attachments={<Text testID="slot-attachments">attachments</Text>}
        editor={<Text testID="slot-editor">editor</Text>}
        error={<Text testID="slot-error">error</Text>}
        footer={<Text testID="slot-footer">footer</Text>}
        quote={<Text testID="slot-quote">quote</Text>}
      />,
    );

    expect(screen.getByTestId("composer-surface-layout")).toBeVisible();
    expect(screen.getByTestId("slot-quote")).toBeVisible();
    expect(screen.getByTestId("slot-attachments")).toBeVisible();
    expect(screen.getByTestId("slot-editor")).toBeVisible();
    expect(screen.getByTestId("slot-error")).toBeVisible();
    expect(screen.getByTestId("slot-footer")).toBeVisible();
  });

  it("includes the Web border inside the surface height contract", () => {
    const source = readFileSync(
      join(__dirname, "composer-material-surface.web.tsx"),
      "utf8",
    );

    expect(source).toContain('boxSizing: "border-box"');
  });

  it("forwards only non-interactive Web background presses", () => {
    expect(
      shouldForwardComposerSurfacePress({
        button: 0,
        defaultPrevented: false,
        target: {closest: () => null},
      }),
    ).toBe(true);
    expect(
      shouldForwardComposerSurfacePress({
        button: 0,
        defaultPrevented: false,
        target: {closest: () => ({})},
      }),
    ).toBe(false);
    expect(
      shouldForwardComposerSurfacePress({
        button: 1,
        defaultPrevented: false,
        target: {closest: () => null},
      }),
    ).toBe(false);
    expect(
      shouldForwardComposerSurfacePress({
        button: 0,
        defaultPrevented: true,
        target: {closest: () => null},
      }),
    ).toBe(false);
  });

  it("exports matching Web and Native footer and material contracts", async () => {
    const screen = await render(
      <>
        <ComposerFooter
          leadingActions={<Text>web leading</Text>}
          primaryAction={<Text>web primary</Text>}
          surfaceMode="desktop"
        />
        <NativeComposerFooter
          leadingActions={<Text>native leading</Text>}
          primaryAction={<Text>native primary</Text>}
          surfaceMode="native"
        />
        <NativeComposerMaterialSurface surfaceMode="native">
          <Text>native surface</Text>
        </NativeComposerMaterialSurface>
      </>,
    );

    expect(screen.getByText("web primary")).toBeVisible();
    expect(screen.getByText("native primary")).toBeVisible();
    expect(screen.getByText("native surface")).toBeVisible();
  });
});
