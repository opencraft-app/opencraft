import { resolveApiBaseUrl } from "./api-base-url";

describe("resolveApiBaseUrl", () => {
  it("accepts a browser backend override and normalizes the v1 base path", () => {
    expect(
      resolveApiBaseUrl({
        browserHostname: "127.0.0.1",
        environmentUrl: "https://api.example.test",
        search: "?backend=http%3A%2F%2F127.0.0.1%3A18080",
      }),
    ).toBe("http://127.0.0.1:18080/v1");
  });

  it("ignores backend query overrides outside a loopback development page", () => {
    expect(
      resolveApiBaseUrl({
        browserHostname: "app.example.test",
        environmentUrl: "https://api.example.test",
        search: "?backend=https%3A%2F%2Fattacker.example",
      }),
    ).toBe("https://api.example.test/v1");
    expect(
      resolveApiBaseUrl({
        browserHostname: "localhost",
        environmentUrl: "https://api.example.test",
        search: "?backend=http%3A%2F%2F127.0.0.1%3A18081",
      }),
    ).toBe("http://127.0.0.1:18081/v1");
  });

  it("falls back to the configured environment and then local backend", () => {
    expect(
      resolveApiBaseUrl({
        environmentUrl: "https://api.example.test/platform/",
      }),
    ).toBe("https://api.example.test/platform/v1");
    expect(resolveApiBaseUrl({})).toBe("http://127.0.0.1:18080/v1");
  });

  it("uses the page origin for a deployed web client", () => {
    expect(
      resolveApiBaseUrl({
        browserHostname: "9.135.236.64",
        browserOrigin: "http://9.135.236.64",
      } as Parameters<typeof resolveApiBaseUrl>[0]),
    ).toBe("http://9.135.236.64/v1");
  });
});
