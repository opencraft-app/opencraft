import { describe, expect, it, vi } from "vitest";
import {
  initAegis,
  resetAegisForTest,
  resolveAegisConfig,
  setAegisUser,
} from "@/observability/aegis";

const aegisMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock("aegis-web-sdk", () => ({
  default: class MockAegis {
    setConfig = aegisMock.setConfig;

    constructor(options: unknown) {
      aegisMock.constructor(options);
    }
  },
}));

describe("resolveAegisConfig", () => {
  it("treats a missing bundler env as disabled", () => {
    expect(resolveAegisConfig(null as never, "cn")).toBeNull();
  });

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

  it("resolves config from Next public env when NODE_ENV is production", () => {
    expect(resolveAegisConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_AEGIS_ID: "cn-id",
      NEXT_PUBLIC_AEGIS_HOST_URL: "https://rumt-zh.com",
    }, "cn")).toEqual({
      id: "cn-id",
      hostUrl: "https://rumt-zh.com",
      region: "cn",
    });
  });

  it("prefers Next public env over legacy Vite env", () => {
    expect(resolveAegisConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_AEGIS_ID: "next-id",
      NEXT_PUBLIC_AEGIS_HOST_URL: "https://rumt-next.com",
      VITE_AEGIS_ID: "vite-id",
      VITE_AEGIS_HOST_URL: "https://rumt-vite.com",
    }, "global")).toEqual({
      id: "next-id",
      hostUrl: "https://rumt-next.com",
      region: "global",
    });
  });

  it("does not enable RUM outside production even with Next env ids", () => {
    expect(resolveAegisConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_AEGIS_ID: "cn-id",
      NEXT_PUBLIC_AEGIS_HOST_URL: "https://rumt-zh.com",
    }, "cn")).toBeNull();
  });

  it("respects an explicit Next disable flag in production", () => {
    expect(resolveAegisConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_AEGIS_ENABLED: "false",
      NEXT_PUBLIC_AEGIS_ID: "cn-id",
      NEXT_PUBLIC_AEGIS_HOST_URL: "https://rumt-zh.com",
    }, "cn")).toBeNull();
  });
});

describe("initAegis", () => {
  it("applies a user id that arrives before the SDK finishes initializing", async () => {
    resetAegisForTest();
    aegisMock.constructor.mockClear();
    aegisMock.setConfig.mockClear();

    setAegisUser("usr_123");
    await initAegis({
      PROD: true,
      VITE_AEGIS_ID: "cn-id",
      VITE_AEGIS_HOST_URL: "https://rumt-zh.com",
    }, "cn");

    expect(aegisMock.constructor).toHaveBeenCalledWith({
      id: "cn-id",
      hostUrl: "https://rumt-zh.com",
      reportApiSpeed: true,
      reportAssetSpeed: true,
      spa: true,
    });
    expect(aegisMock.setConfig).toHaveBeenCalledWith({ uin: "usr_123" });
  });
});
