import { SecureCredentialStore } from "./secure-credential-store";

describe("SecureCredentialStore", () => {
  it("uses the platform secure storage for the refresh token", async () => {
    const values = new Map<string, string>();
    const store = new SecureCredentialStore({
      deleteItemAsync: async (key) => {
        values.delete(key);
      },
      getItemAsync: async (key) => values.get(key) ?? null,
      setItemAsync: async (key, value) => {
        values.set(key, value);
      },
    });

    await store.saveRefreshToken("refresh-native");
    expect(await store.loadRefreshToken()).toBe("refresh-native");

    await store.clear();
    expect(values.size).toBe(0);
  });

  it("continues serializing after a failed operation", async () => {
    const store = new SecureCredentialStore({
      deleteItemAsync: async () => undefined,
      getItemAsync: async () => null,
      setItemAsync: async () => undefined,
    });
    const order: string[] = [];

    await expect(
      store.runExclusive(async () => {
        order.push("failed");
        throw new Error("rotation failed");
      }),
    ).rejects.toThrow("rotation failed");
    await store.runExclusive(async () => {
      order.push("next");
    });

    expect(order).toEqual(["failed", "next"]);
  });
});
