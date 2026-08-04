import {render} from "@testing-library/react-native";
import {Pressable} from "react-native";

import {ExpoNavigationLink} from "./expo-navigation-link";

const mockLinkSpy = jest.fn(
  ({children}: {children: React.ReactNode}) => children,
);

jest.mock("expo-router", () => ({
  Link: (props: {children: React.ReactNode}) => mockLinkSpy(props),
}));

describe("ExpoNavigationLink", () => {
  beforeEach(() => {
    mockLinkSpy.mockClear();
  });

  it("forwards the child style because Expo Link asChild replaces it on web", async () => {
    const style = {borderRadius: 12, minHeight: 48, width: "100%" as const};

    await render(
      <ExpoNavigationLink href="/s/tencent/tasks">
        <Pressable style={style} />
      </ExpoNavigationLink>,
    );

    expect(mockLinkSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({style}),
    );
  });

  it("resolves Pressable callback styles before forwarding them to Expo Link", async () => {
    const style = jest.fn(() => ({height: 44, width: 44}));

    await render(
      <ExpoNavigationLink href="/s/tencent/computers">
        <Pressable style={style} />
      </ExpoNavigationLink>,
    );

    expect(style).toHaveBeenCalledWith({hovered: false, pressed: false});
    expect(mockLinkSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({style: {height: 44, width: 44}}),
    );
  });
});
