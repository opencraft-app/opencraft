import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPersistedFeatureState } from "@/lib/persisted-feature-state";

const STORAGE_KEY = "lightvela:test-feature-state:v1";

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("createPersistedFeatureState", () => {
  it("persists explicit true and false values across controller recreation", () => {
    const first = createPersistedFeatureState({ id: "test", storageKey: STORAGE_KEY });
    expect(first.get()).toBe(false);
    expect(first.toggle()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");

    const recreated = createPersistedFeatureState({ id: "test", storageKey: STORAGE_KEY });
    expect(recreated.get()).toBe(true);
    expect(recreated.toggle()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("0");
  });

  it("publishes current, local, and cross-tab state through one subscription", () => {
    const state = createPersistedFeatureState({ id: "test", storageKey: STORAGE_KEY });
    const listener = vi.fn();
    const dispose = state.subscribe(listener);

    expect(listener).toHaveBeenLastCalledWith(false);
    state.set(true);
    expect(listener).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(new StorageEvent("storage", {
      key: STORAGE_KEY,
      newValue: "0",
    }));
    expect(listener).toHaveBeenLastCalledWith(false);
    dispose();
  });

  it("retains in-page authority when browser storage is unavailable", () => {
    const host = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    const state = createPersistedFeatureState({ id: "test", storageKey: STORAGE_KEY });

    expect(state.toggle(host)).toBe(true);
    expect(state.get(host)).toBe(true);
  });
});
