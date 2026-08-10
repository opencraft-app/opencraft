import {fireEvent, render} from "@testing-library/react-native";
import {Text} from "react-native";

import {ManagementPreferenceSection} from "./management-preference";

describe("management preference composition", () => {
  it("owns the separators between section items", async () => {
    const screen = await render(
      <ManagementPreferenceSection description="说明" title="基本信息">
        <Text>名称</Text>
        <Text>描述</Text>
        <Text>保存</Text>
      </ManagementPreferenceSection>,
    );

    expect(screen.getAllByTestId("management-preference-separator"))
      .toHaveLength(2);
  });

  it("provides one typed status and action footer", async () => {
    const preference = require("./management-preference") as Record<string, unknown>;
    const Footer = preference.ManagementPreferenceFooter as undefined | ((props: {
      action: {label: string; onPress(): void; testID: string};
      status: string;
      testID: string;
    }) => React.ReactNode);
    expect(Footer).toBeDefined();
    if (!Footer) return;
    const onPress = jest.fn();
    const screen = await render(
      <Footer
        action={{label: "保存", onPress, testID: "preference-save"}}
        status="有未保存的更改"
        testID="preference-footer"
      />,
    );

    expect(screen.getByTestId("preference-footer")).toHaveStyle({
      flexDirection: "row",
    });
    await fireEvent.press(screen.getByTestId("preference-save"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
