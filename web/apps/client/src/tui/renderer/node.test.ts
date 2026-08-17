import {
  appendChild,
  createHostInstance,
  createRawTextInstance,
  serializeRoot,
} from "./node";
import {HandlerRegistry} from "./registry";

describe("ReactVaxis NativeNode serialization", () => {
  it("publishes plain data and keeps callbacks behind handler IDs", () => {
    const onPress = jest.fn();
    const root = createHostInstance("View", {
      style: {direction: "column", gap: 1, surface: "canvas"},
      testID: "root",
    });
    const button = createHostInstance("Button", {
      disabled: false,
      onPress,
      testID: "open-general",
      title: "打开 general",
    });
    const text = createHostInstance("Text", {maxLines: 2});
    appendChild(text, createRawTextInstance("general"));
    appendChild(button, text);
    appendChild(root, button);
    const registry = new HandlerRegistry();

    registry.beginCommit();
    const snapshot = serializeRoot([root], registry);
    registry.endCommit();

    expect(snapshot).toEqual({
      children: [
        {
          children: [{maxLines: 2, text: "general", type: "Text"}],
          disabled: false,
          onPress: expect.stringMatching(/^handler-/),
          testId: "open-general",
          title: "打开 general",
          type: "Button",
        },
      ],
      style: {direction: "column", gap: 1, surface: "canvas"},
      testId: "root",
      type: "View",
    });
    expect(JSON.stringify(snapshot)).not.toContain("onPress(){}");
    expect(registry.dispatch(snapshot.children![0]!.onPress!, {})).toBe(true);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("rejects raw text outside the Text primitive", () => {
    const root = createHostInstance("View", {});
    appendChild(root, createRawTextInstance("invalid"));
    const registry = new HandlerRegistry();

    registry.beginCommit();
    expect(() => serializeRoot([root], registry)).toThrow(
      "Raw text must be nested under Text",
    );
  });
});
