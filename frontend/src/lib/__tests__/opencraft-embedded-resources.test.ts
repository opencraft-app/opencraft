import { afterEach, expect, it, vi } from "vitest";

import { clearEmbeddedWorkbenchModuleReload, markEmbeddedWorkbenchModuleReload } from "../opencraft-embedded-resources";

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

it("allows one automatic module reload until the module loads successfully", () => {
  expect(markEmbeddedWorkbenchModuleReload()).toBe(true);
  expect(markEmbeddedWorkbenchModuleReload()).toBe(false);
  clearEmbeddedWorkbenchModuleReload();
  expect(markEmbeddedWorkbenchModuleReload()).toBe(true);
});

it("avoids an unbounded automatic reload when session storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(markEmbeddedWorkbenchModuleReload()).toBe(false);
});
