import {act, useState} from "react";

import {createReactVaxisRenderer} from "./renderer/reconciler";
import {TextInput} from "./primitives";

describe("ReactVaxis primitives", () => {
  it("acknowledges native text event counts without replacing the handler", async () => {
    const renderer = createReactVaxisRenderer(() => undefined);

    function ControlledInput() {
      const [value, setValue] = useState("");
      return (
        <TextInput
          onChangeText={(payload) => setValue(String(payload.value ?? ""))}
          testID="input"
          value={value}
        />
      );
    }

    let committed: Promise<void> | undefined;
    await act(async () => {
      committed = renderer.render(<ControlledInput />);
    });
    await committed;
    const initial = renderer.latestSnapshot();
    expect(initial?.mostRecentEventCount).toBe(0);
    expect(initial?.onChangeText).toBeDefined();

    await act(async () => {
      renderer.dispatch(initial!.onChangeText!, {eventCount: 3, value: "vela"});
    });

    const updated = renderer.latestSnapshot();
    expect(updated?.value).toBe("vela");
    expect(updated?.mostRecentEventCount).toBe(3);
    expect(updated?.onChangeText).toBe(initial?.onChangeText);
  });
});
