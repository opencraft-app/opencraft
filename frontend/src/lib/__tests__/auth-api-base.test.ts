import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfiguredAuthApiBaseUrl, PAGES_DEV_SUBDOMAIN_TO_API_HOST } from "@/lib/auth-api-base";

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

  it("routes lightclaw.pages.dev (production preview) to the main lightclaw.tech backend", () => {
    stubLocation("lightclaw.pages.dev");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://lightclaw.tech");
  });

  it("routes the international LightVela site to its auth API", () => {
    stubLocation("lightvela.ai");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://api.lightvela.ai");
  });

  it("routes sandbox-2 pages.dev subdomain to its own sandbox backend host", () => {
    // 关键回归：bj82.lightclaw.pages.dev 不能落回 https://lightclaw.tech，
    // 否则 session cookie / CORS 与真实所在环境 (api-bj82.lightclaw.tech) 错配，
    // /support/feedback/presign 之类的接口会拿到 502 / 401。
    stubLocation("bj82.lightclaw.pages.dev");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://api-bj82.lightclaw.tech");
  });

  it("routes sandbox-bj-7 pages.dev subdomain to its own sandbox backend host", () => {
    stubLocation("sandbox-bj-7.lightclaw.pages.dev");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://api-sandbox-bj-7.lightclaw.tech");
  });

  it("falls back to lightclaw.tech for other pages.dev subdomains", () => {
    // 未显式映射的子域按兜底策略走主站后端（当前生产 preview 分支等场景）。
    stubLocation("other.lightclaw.pages.dev");

    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://lightclaw.tech");
  });

  it("ignores sandbox host mapping when mapped value is not a valid https URL", () => {
    // 回归：PAGES_DEV_SUBDOMAIN_TO_API_HOST 配置错误时（如 value 不以 https:// 开头）
    // 不应返回无效值，而是 fallback 到后续兜底策略。

    // 1. 验证现有映射表里所有 value 均符合 https:// 格式。
    for (const host of Object.values(PAGES_DEV_SUBDOMAIN_TO_API_HOST)) {
      expect(host, `mapping value "${host}" should start with https://`).toMatch(/^https:\/\//);
    }

    // 2. 临时注入一条格式非法的映射，验证合法性校验能过滤掉它。
    const testKey = "bad-config.lightclaw.pages.dev";
    (PAGES_DEV_SUBDOMAIN_TO_API_HOST as Record<string, string>)[testKey] = "//invalid-no-scheme";
    stubLocation(testKey);
    // 不合法时应 fallback：testKey 属于 .lightclaw.pages.dev，兜底返回 https://lightclaw.tech。
    expect(resolveConfiguredAuthApiBaseUrl()).toBe("https://lightclaw.tech");
    // 清理临时注入，避免影响其他用例。
    delete (PAGES_DEV_SUBDOMAIN_TO_API_HOST as Record<string, string>)[testKey];
  });
});
