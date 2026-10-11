import {fireEvent, render} from "@testing-library/react-native";
import {memo, useState} from "react";
import {Pressable, Text} from "react-native";
import type { StoreApi } from "zustand/vanilla";
import type { AppStoreState } from "../application/app-store";
import {
  AppRuntimeProvider,
  useAppRuntime,
} from "./app-runtime";

describe("AppRuntimeProvider", () => {
  it("shares one injected store with the whole route tree", async () => {
    const store = {} as StoreApi<AppStoreState>;

    function Probe() {
      const runtime = useAppRuntime();
      return <Text>{runtime.store === store ? "same-store" : "wrong"}</Text>;
    }

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <Probe />
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("same-store")).toBeVisible();
  });

  it("keeps the runtime context stable when the provider parent rerenders", async () => {
    const store = {} as StoreApi<AppStoreState>;
    const renderProbe = jest.fn();
    const Probe = memo(function Probe() {
      useAppRuntime();
      renderProbe();
      return <Text>runtime-probe</Text>;
    });
    function Harness() {
      const [count, setCount] = useState(0);
      return (
        <AppRuntimeProvider store={store}>
          <Pressable onPress={() => setCount(value => value + 1)}>
            <Text>刷新父级 {count}</Text>
          </Pressable>
          <Probe />
        </AppRuntimeProvider>
      );
    }

    const screen = await render(<Harness />);
    expect(renderProbe).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText("刷新父级 0"));
    expect(screen.getByText("刷新父级 1")).toBeVisible();
    expect(renderProbe).toHaveBeenCalledTimes(1);
  });
});
