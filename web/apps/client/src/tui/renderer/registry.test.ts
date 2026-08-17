import {HandlerRegistry} from "./registry";

describe("HandlerRegistry", () => {
  it("keeps mounted callbacks stable and rejects stale handler IDs", () => {
    const registry = new HandlerRegistry();
    const owner = {};
    const firstCallback = jest.fn();

    registry.beginCommit();
    const firstID = registry.bind(owner, "onPress", firstCallback);
    const repeatedID = registry.bind(owner, "onPress", firstCallback);
    registry.endCommit();

    expect(repeatedID).toBe(firstID);
    expect(registry.dispatch(firstID, {source: "keyboard"})).toBe(true);
    expect(firstCallback).toHaveBeenCalledWith({source: "keyboard"});

    const replacement = jest.fn();
    registry.beginCommit();
    const replacementID = registry.bind(owner, "onPress", replacement);
    registry.endCommit();

    expect(replacementID).not.toBe(firstID);
    expect(registry.dispatch(firstID, {})).toBe(false);
    expect(registry.dispatch(replacementID, {source: "mouse"})).toBe(true);
    expect(replacement).toHaveBeenCalledWith({source: "mouse"});

    registry.beginCommit();
    registry.endCommit();

    expect(registry.dispatch(replacementID, {})).toBe(false);
  });
});
