import {fireEvent, render} from "@testing-library/react-native";

import {LocalDateTimeInput} from "./local-date-time-input.web";

describe("LocalDateTimeInput web", () => {
  it("uses the browser datetime-local control and forwards its value", async () => {
    const onChangeText = jest.fn();
    const screen = await render(
      <LocalDateTimeInput
        accessibilityLabel="邀请有效期"
        onChangeText={onChangeText}
        value="2026-08-03T16:00"
      />,
    );
    const input = screen.getByLabelText("邀请有效期");

    expect(input.props.type).toBe("datetime-local");
    fireEvent(input, "change", {target: {value: "2026-08-04T18:30"}});
    expect(onChangeText).toHaveBeenCalledWith("2026-08-04T18:30");
  });
});
