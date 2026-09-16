import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWindowCommand, type WindowCommandHost } from "../window-command-chain";

const host = window as WindowCommandHost;
afterEach(() => { delete host.show; delete host.hide; });

describe("window command ownership", () => {
  it.each([[0, 1, 2], [0, 2, 1], [2, 0, 1], [2, 1, 0], [1, 0, 2], [1, 2, 0]])("removes three consumers in order %j without reviving inactive handlers", (first, second, third) => {
    const original = vi.fn(function (this: Window, ...args: unknown[]) { expect(this).toBe(window); expect(args).toEqual(["x", 9]); return false; });
    host.show = original;
    const handlers = [vi.fn(), vi.fn(), vi.fn()];
    const cleanups = handlers.map((handler) => registerWindowCommand(host, "show", (next, ...args) => { handler(); return next(...args); }));
    expect(host.show?.("x", 9)).toBe(false);
    handlers.forEach((handler) => expect(handler).toHaveBeenCalledTimes(1));
    const removed: number[] = [];
    for (const index of [first, second]) {
      cleanups[index]!();
      removed.push(index);
      handlers.forEach((handler) => handler.mockClear());
      expect(host.show?.("x", 9)).toBe(false);
      removed.forEach((inactive) => expect(handlers[inactive]).not.toHaveBeenCalled());
    }
    cleanups[third]!();
    expect(host.show).toBe(original);
    expect(host.show?.("x", 9)).toBe(false);
    expect(original).toHaveBeenCalledTimes(4);
  });

  it("keeps each caller's undefined fallback and returns defined values through the chain", () => {
    for (const result of [undefined, false, null, 0, "original"]) {
      host.show = () => result;
      const remove = registerWindowCommand(host, "show", (next, ...args) => { const value = next(...args); return value === undefined ? true : value; });
      expect(host.show?.()).toBe(result === undefined ? true : result);
      remove();
    }
  });

  it("deletes originally absent commands and supports repeated cleanup", () => {
    const remove = registerWindowCommand(host, "hide", (next, ...args) => next(...args) ?? true);
    expect(host.hide?.()).toBe(true);
    remove(); remove();
    expect(host).not.toHaveProperty("hide");
  });

  it("propagates an original handler exception once and never invokes unmounted callbacks", () => {
    const error = new Error("original handler failed");
    const original = vi.fn(() => { throw error; }); host.show = original;
    const removedHandler = vi.fn(); const liveHandler = vi.fn();
    const removeA = registerWindowCommand(host, "show", (next, ...args) => { removedHandler(); return next(...args); });
    const removeB = registerWindowCommand(host, "show", (next, ...args) => { liveHandler(); return next(...args); });
    removeA();
    expect(() => host.show?.("arg")).toThrow(error);
    expect(original).toHaveBeenCalledExactlyOnceWith("arg");
    expect(removedHandler).not.toHaveBeenCalled();
    expect(liveHandler).toHaveBeenCalledTimes(1);
    removeB();
    expect(host.show).toBe(original);
  });

  it("preserves a later external owner and does not call a removed handler through its captured dispatcher", () => {
    const original = vi.fn(() => "original"); host.show = original;
    const handler = vi.fn();
    const removeA = registerWindowCommand(host, "show", (next, ...args) => { handler(); return next(...args); });
    const captured = host.show!;
    const external = vi.fn((...args: unknown[]) => captured(...args)); host.show = external;
    const removeB = registerWindowCommand(host, "show", (next, ...args) => next(...args));
    removeA(); removeB();
    expect(host.show).toBe(external);
    expect(host.show?.()).toBe("original");
    expect(handler).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledTimes(1);
  });
});
