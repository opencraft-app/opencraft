import {render} from "@testing-library/react-native";
import {createStore} from "zustand/vanilla";

import type {AppStoreState} from "../../application/app-store";
import RegisterRoute from "../../app/(auth)/register";
import {AppRuntimeProvider} from "../../runtime/app-runtime";

jest.mock("expo-router", () => {
  const {Text: MockText} = jest.requireActual("react-native");
  return {
    Redirect: ({href}: {href: string}) => <MockText>{href}</MockText>,
    useLocalSearchParams: () => ({returnTo: "/s/atlas"}),
    useRouter: () => ({push: jest.fn()}),
  };
});

describe("RegisterRoute", () => {
  it("sends a new account without that Server to first-workspace onboarding", async () => {
    const store = createStore<AppStoreState>(() =>
      ({
        authStatus: "signed_in",
        error: null,
        servers: [],
        serversStatus: "ready",
      }) as unknown as AppStoreState,
    );

    const screen = await render(
      <AppRuntimeProvider store={store}>
        <RegisterRoute />
      </AppRuntimeProvider>,
    );

    expect(screen.getByText("/home")).toBeVisible();
    expect(screen.queryByText("/s/atlas")).toBeNull();
  });
});
