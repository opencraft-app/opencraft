import {act} from "react";

import {Text, View} from "../primitives";
import {
  createReactVaxisRenderer,
  type ReactVaxisRenderer,
} from "./reconciler";

async function render(
  renderer: ReactVaxisRenderer,
  element: React.ReactNode,
): Promise<void> {
  let committed: Promise<void> | undefined;
  await act(async () => {
    committed = renderer.render(element);
  });
  await committed;
}

describe("ReactVaxis React renderer", () => {
  it("publishes one immutable snapshot after each React commit", async () => {
    const commits: unknown[] = [];
    const renderer = createReactVaxisRenderer((tree) => commits.push(tree));

    await render(
      renderer,
      <View testID="root">
        <Text>first</Text>
      </View>,
    );

    expect(commits).toEqual([
      {
        children: [{text: "first", type: "Text"}],
        testId: "root",
        type: "View",
      },
    ]);

    await render(
      renderer,
      <View testID="root">
        <Text>second</Text>
      </View>,
    );

    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual({
      children: [{text: "second", type: "Text"}],
      testId: "root",
      type: "View",
    });
  });

  it("dispatches only handlers mounted by the latest commit", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const renderer = createReactVaxisRenderer(() => undefined);

    await render(renderer, <View onPress={first} testID="root" />);
    const firstID = renderer.latestSnapshot()!.onPress!;
    await render(renderer, <View onPress={second} testID="root" />);
    const secondID = renderer.latestSnapshot()!.onPress!;

    expect(renderer.dispatch(firstID, {})).toBe(false);
    expect(renderer.dispatch(secondID, {source: "keyboard"})).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({source: "keyboard"});
  });
});
