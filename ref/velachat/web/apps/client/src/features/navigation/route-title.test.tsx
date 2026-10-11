import {render} from "@testing-library/react-native";

import {RouteTitle} from "./route-title";

jest.mock("expo-router", () => ({
  Stack: {Screen: () => null},
  useFocusEffect: (effect: () => void) => effect(),
}));

describe("RouteTitle", () => {
  it("updates the browser document title when the route changes", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );
    const mockDocument = {title: "Vela"};
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: mockDocument,
    });
    const screen = await render(<RouteTitle title="登录 · VELA" />);
    expect(mockDocument.title).toBe("登录 · VELA");

    await screen.rerender(<RouteTitle title="# 闲聊 · Atlas" />);
    expect(mockDocument.title).toBe("# 闲聊 · Atlas");
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  });
});
