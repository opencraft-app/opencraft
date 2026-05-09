import { describe, expect, it } from "vitest";
import { resolveAegisConfig } from "@/observability/aegis";

describe("resolveAegisConfig", () => {
  it("does not enable RUM for dev builds", () => {
    expect(resolveAegisConfig({ PROD: false, VITE_AEGIS_ID: "rum-id" }, "cn")).toBeNull();
  });

  it("does not enable RUM without an id", () => {
    expect(resolveAegisConfig({ PROD: true, VITE_AEGIS_ENABLED: "auto" }, "cn")).toBeNull();
  });

  it("does not enable RUM without an explicit report host", () => {
    expect(resolveAegisConfig({ PROD: true, VITE_AEGIS_ID: "cn-id" }, "cn")).toBeNull();
  });

  it("resolves China Aegis config from explicit release env", () => {
    expect(resolveAegisConfig({
      PROD: true,
      VITE_AEGIS_ID: "cn-id",
      VITE_AEGIS_HOST_URL: "https://rumt-zh.com",
    }, "cn")).toEqual({
      id: "cn-id",
      hostUrl: "https://rumt-zh.com",
      region: "cn",
    });
  });

  it("resolves global Aegis config from explicit release env", () => {
    expect(resolveAegisConfig({
      PROD: true,
      VITE_AEGIS_ID: "global-id",
      VITE_AEGIS_HOST_URL: "https://rumt-sg.com",
    }, "global")).toEqual({
      id: "global-id",
      hostUrl: "https://rumt-sg.com",
      region: "global",
    });
  });

  it("allows release matrix host overrides", () => {
    expect(resolveAegisConfig({
      PROD: true,
      VITE_AEGIS_ID: "global-id",
      VITE_AEGIS_HOST_URL: "https://rumt-us.com",
    }, "global")?.hostUrl).toBe("https://rumt-us.com");
  });
});
