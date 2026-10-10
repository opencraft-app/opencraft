import {render} from "@testing-library/react-native";
import {Text} from "react-native";

import {velaTheme} from "../tokens";
import {SystemPage} from "./system-page";

describe("SystemPage primary header", () => {
  it("routes management title and actions through the shared floating surface", async () => {
    const screen = await render(
      <SystemPage
        actions={<Text>刷新</Text>}
        eyebrow="Agent 管理"
        layoutMode="wide"
        summary="2 个 Agent"
        title="Agent"
      >
        <Text>内容</Text>
      </SystemPage>,
    );

    expect(screen.getByTestId("management-primary-header-slot")).toHaveStyle({
      paddingHorizontal: velaTheme.spacing.lg,
    });
    expect(screen.getByTestId("management-primary-header")).toBeVisible();
    expect(screen.getByText("Agent")).toBeVisible();
    expect(screen.getByText("刷新")).toBeVisible();
    expect(screen.getByTestId("management-header")).not.toHaveStyle({
      borderBottomWidth: velaTheme.semantic.stroke.hairline,
    });
  });

  it("keeps compact viewport layout independent from content density", async () => {
    const screen = await render(
      <SystemPage density="comfortable" layoutMode="compact" title="设置">
        <Text>内容</Text>
      </SystemPage>,
    );

    expect(screen.getByTestId("management-primary-header-slot")).toHaveStyle({
      paddingHorizontal: velaTheme.spacing.sm,
    });
    expect(screen.getByTestId("system-page-content")).toBeVisible();
  });
});
