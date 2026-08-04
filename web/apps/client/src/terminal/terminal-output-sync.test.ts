import {computeTerminalOutputPatch} from "./terminal-output-sync";

describe("computeTerminalOutputPatch", () => {
  it("writes only appended PTY bytes", () => {
    const previous = new TextEncoder().encode("hello");
    const next = new TextEncoder().encode("hello world");

    const patch = computeTerminalOutputPatch(previous, next);

    expect(patch.reset).toBe(false);
    expect(new TextDecoder().decode(patch.data)).toBe(" world");
  });

  it("resets xterm when the bounded controller buffer drops old bytes", () => {
    const previous = new TextEncoder().encode("old output");
    const next = new TextEncoder().encode("new output");

    const patch = computeTerminalOutputPatch(previous, next);

    expect(patch.reset).toBe(true);
    expect(patch.data).toBe(next);
  });

  it("does nothing for the same snapshot", () => {
    const bytes = new TextEncoder().encode("same");

    const patch = computeTerminalOutputPatch(bytes, bytes);

    expect(patch.reset).toBe(false);
    expect(patch.data.byteLength).toBe(0);
  });
});
