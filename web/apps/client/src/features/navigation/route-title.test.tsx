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
    const mockDocument = {title: "Raft"};
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: mockDocument,
    });
    const screen = await render(<RouteTitle title="登录 · RAFT" />);
    expect(mockDocument.title).toBe("登录 · RAFT");

    await screen.rerender(<RouteTitle title="# 闲聊 · Atlas" />);
    expect(mockDocument.title).toBe("# 闲聊 · Atlas");
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  });
});
