import {SessionJoinIntentStore} from "./session-join-intent-store";

class MemorySessionStorage {
  public readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("SessionJoinIntentStore", () => {
  it("captures only the fragment token and keeps it for 30 minutes", () => {
    const storage = new MemorySessionStorage();
    const store = new SessionJoinIntentStore(storage);
    const now = Date.parse("2026-08-04T08:00:00.000Z");

    expect(
      store.capture("#token=rfi_join_token_long_enough_123", now),
    ).toBe(true);
    expect(store.load(now + 29 * 60_000)).toBe(
      "rfi_join_token_long_enough_123",
    );
    expect(store.load(now + 30 * 60_000)).toBeNull();
  });

  it("never accepts a token from a query string or malformed fragment", () => {
    const storage = new MemorySessionStorage();
    const store = new SessionJoinIntentStore(storage);

    expect(store.capture("?token=rfi_query_token_long_enough", 1)).toBe(false);
    expect(store.capture("#other=rfi_fragment_token_long_enough", 1)).toBe(false);
    expect(store.load(1)).toBeNull();
  });

  it("clears the current-tab intent after success or cancellation", () => {
    const storage = new MemorySessionStorage();
    const store = new SessionJoinIntentStore(storage);
    store.capture("#token=rfi_join_token_long_enough_123", 1);

    store.clear();

    expect(store.load(2)).toBeNull();
  });
});
