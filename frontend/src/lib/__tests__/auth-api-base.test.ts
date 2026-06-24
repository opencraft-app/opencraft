import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";

const stubLocation = (hostname: string) => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      hostname,
      host: hostname,
      origin: `http://${hostname}`,
      protocol: "http:",
    },
  });
};

describe("resolveConfiguredAuthApiBaseUrl", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_BASE_URL", "");
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "");
  });

  it("uses the live auth backend for local Next previews without a proxy env", () => {
    stubLocation("127.0.0.1");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://lightclaw.tech");
  });

  it("keeps same-origin requests only when local-proxy is explicit", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_BASE_URL", "local-proxy");
    stubLocation("127.0.0.1");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("");
  });
});
