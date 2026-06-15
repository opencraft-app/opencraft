import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountApp } from "@/app/mount";

const mocks = vi.hoisted(() => {
  const render = vi.fn();
  return {
    render,
    createRoot: vi.fn(() => ({ render })),
    hydrateRoot: vi.fn(),
  };
});

vi.mock("react-dom/client", () => ({
  createRoot: mocks.createRoot,
  hydrateRoot: mocks.hydrateRoot,
}));

vi.mock("@/app/app", () => ({
  App: () => <div>app</div>,
}));

describe("mountApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates when the root already contains static HTML", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.innerHTML = "<main>static</main>";

    mountApp(root);

    expect(mocks.hydrateRoot).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateRoot).toHaveBeenCalledWith(root, expect.anything());
    expect(mocks.createRoot).not.toHaveBeenCalled();
  });

  it("creates a new root when the root is empty", () => {
    const root = document.createElement("div");
    root.id = "root";

    mountApp(root);

    expect(mocks.createRoot).toHaveBeenCalledTimes(1);
    expect(mocks.createRoot).toHaveBeenCalledWith(root);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateRoot).not.toHaveBeenCalled();
  });
});
