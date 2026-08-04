import { BrowserCredentialStore } from "./browser-credential-store";

describe("BrowserCredentialStore", () => {
  it("persists only the refresh token under the client-scoped key", async () => {
    const values = new Map<string, string>();
    const store = new BrowserCredentialStore({
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
    });

    await store.saveRefreshToken("refresh-token");

    expect([...values.entries()]).toEqual([
      ["vela.client.refresh-token", "refresh-token"],
    ]);
    expect(await store.loadRefreshToken()).toBe("refresh-token");

    await store.clear();

    expect(await store.loadRefreshToken()).toBeNull();
  });

  it("serializes credential rotations inside one client process", async () => {
    const values = new Map<string, string>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new BrowserCredentialStore({
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
    });

    const first = store.runExclusive(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = store.runExclusive(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
