import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_UNAUTHORIZED_EVENT,
  createHttpRepositories,
  createRepositories,
  readStoredAuthToken,
  writeStoredAuthToken,
} from "@/repositories/http-repositories";

const AUTH_TOKEN_STORAGE_KEY = "lightclaw-auth-token-v1";

describe("http repositories auth token bootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    globalThis.localStorage.clear();
    window.history.replaceState({}, "", "/auth/sign-in");
  });

  const stubHostname = (hostname: string) => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hostname,
        host: hostname,
        protocol: "https:",
      },
    });
  };

  const expectOAuthStartURL = (actual: string | null, expectedBase: string, expectedReturnTo: string) => {
    expect(actual).not.toBeNull();
    const parsed = new URL(actual!);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(expectedBase);
    expect(parsed.searchParams.get("return_to")).toBe(expectedReturnTo);
  };

  it("bootstraps a session token from the oauth callback fragment and cleans the url", () => {
    window.history.replaceState({}, "", "/plans/select#session_token=safari-oauth-token");

    createHttpRepositories("https://lightclaw.tech");

    expect(readStoredAuthToken()).toBe("safari-oauth-token");
    expect(window.location.pathname).toBe("/plans/select");
    expect(window.location.hash).toBe("");
  });

  it("sends the stored bearer token when hydrating session", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: {
              user: {
                id: "usr_123",
                name: "Safari User",
                inviteRequired: false,
                createdAt: "2026-03-20T00:00:00Z",
              },
              impersonated: true,
              sessionToken: "persisted-bearer-token",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "not found",
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const session = await repositories.auth.getSession();

    expect(session?.impersonated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer persisted-bearer-token");
  });

  it("hydrates current subscription from the subscriptions endpoint", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: {
              user: {
                id: "usr_123",
                name: "Plan User",
                inviteRequired: false,
                createdAt: "2026-03-20T00:00:00Z",
              },
              sessionToken: "persisted-bearer-token",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hasSubscription: true,
            subscription: {
              code: "lite",
              status: "active",
              currentPeriodStart: "2026-03-24T00:00:00Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const session = await repositories.auth.getSession();

    expect(session?.currentSubscription).toEqual({
      tier: "plus",
      code: "lite",
      status: "active",
      currentPeriodStart: "2026-03-24T00:00:00Z",
      currentPeriodEnd: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://lightclaw.tech/subscriptions/current",
      expect.any(Object),
    );
  });

  it("treats a missing subscription as no confirmed plan during session hydrate", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session: {
              user: {
                id: "usr_123",
                name: "Plan User",
                inviteRequired: false,
                createdAt: "2026-03-20T00:00:00Z",
              },
              sessionToken: "persisted-bearer-token",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "not found",
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const session = await repositories.auth.getSession();

    expect(session?.currentSubscription).toBeNull();
  });

  it("uses the new subscriptions checkout endpoint when confirming a plan", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "lite",
          mode: "active",
          subscription: {
            code: "lite",
            status: "active",
            currentPeriodStart: "2026-03-24T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const subscription = await repositories.plans.updateSubscription("plus");

    expect(subscription).toEqual({
      tier: "plus",
      code: "lite",
      status: "active",
      currentPeriodStart: "2026-03-24T00:00:00Z",
      currentPeriodEnd: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lightclaw.tech/subscriptions/checkout",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "lite" }),
      }),
    );
  });

  it("loads dashboard bots from ctl instances", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "OK",
          message: "success",
          data: {
            total: 1,
            page: 1,
            page_size: 20,
            items: [
              {
                instance_id: "ins_123456",
                status: "Running",
                created_at: "2026-03-24T00:00:00Z",
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const snapshot = await repositories.bots.getDashboardSnapshot("live");

    expect(snapshot.bots).toEqual([
      expect.objectContaining({
        id: "ins_123456",
        status: "active",
        template: "OpenClaw Runtime",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lightclaw.tech/v1/instances",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("creates bots through ctl instances", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "OK",
          message: "success",
          data: {
            instance_id: "ins_newbot",
            status: "Running",
            created_at: "2026-03-24T00:00:00Z",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const bot = await repositories.bots.createBot({ name: "新实例 Bot" });

    expect(bot).toEqual(
      expect.objectContaining({
        id: "ins_newbot",
        name: "新实例 Bot",
        status: "active",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lightclaw.tech/v1/instances",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ timeout: 3600 }),
      }),
    );
  });

  it("keeps ctl creating instances as provisioning bots", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "OK",
          message: "success",
          data: {
            instance_id: "ins_creating",
            status: "Creating",
            created_at: "2026-03-24T00:00:00Z",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const bot = await repositories.bots.createBot({ name: "创建中 Bot" });

    expect(bot).toEqual(
      expect.objectContaining({
        id: "ins_creating",
        name: "创建中 Bot",
        status: "provisioning",
      }),
    );
  });

  it("creates a tat terminal session for a bot via sandbox session bootstrap", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "OK",
            message: "success",
            data: {
              instance_id: "ins_term123",
              sandbox_id: "sb_term123",
              status: "Running",
              created_at: "2026-03-24T00:00:00Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sandboxId: "sb_term123",
            poolId: "pool-bj8",
            sessionId: "sess-1",
            region: "ap-beijing",
            instanceId: "ins-cloud-1",
            ownerUin: "10001",
            loginUin: "10002",
            appId: 12345,
            wsUrl: "wss://ap-beijing.forward.tat-tc.tencent.cn/ws",
            cols: 120,
            rows: 32,
            timeoutSeconds: 3600,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const session = await repositories.bots.getTerminalSession("ins_term123");

    expect(session).toEqual({
      sandboxId: "sb_term123",
      poolId: "pool-bj8",
      sessionId: "sess-1",
      region: "ap-beijing",
      instanceId: "ins-cloud-1",
      ownerUin: "10001",
      loginUin: "10002",
      appId: 12345,
      wsUrl: "wss://ap-beijing.forward.tat-tc.tencent.cn/ws",
      cols: 120,
      rows: 32,
      timeoutSeconds: 3600,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://lightclaw.tech/v1/instances/ins_term123",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://lightclaw.tech/sandboxes/sb_term123/tat/session",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("configures qq channel for a bot through ctl", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "OK",
          message: "success",
          data: {
            status: "Succeeded",
            channel: "qqbot",
            gateway_restarted: true,
            output: "configured",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const result = await repositories.bots.configureQQChannel("ins_qq123", {
      appId: "123456789",
      appSecret: "app-secret",
    });

    expect(result).toEqual({
      status: "Succeeded",
      channel: "qqbot",
      gatewayRestarted: true,
      output: "configured",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lightclaw.tech/v1/instances/ins_qq123/channels/config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          channel: "qqbot",
          token: "123456789:app-secret",
          account: undefined,
        }),
      }),
    );
  });

  it("destroys bots through ctl instances", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "OK",
          message: "success",
          data: {
            instance_id: "ins_delete_me",
            status: "Deleting",
            created_at: "2026-03-24T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    await repositories.bots.destroyBot("ins_delete_me");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://lightclaw.tech/v1/instances/ins_delete_me",
      expect.objectContaining({
        method: "DELETE",
      }),
    );
  });

  it("loads the current subscription detail from the subscriptions endpoint", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          hasSubscription: true,
          subscription: {
            code: "lite",
            status: "active",
            currentPeriodStart: "2026-03-24T00:00:00Z",
            currentPeriodEnd: "2026-04-24T00:00:00Z",
            createdAt: "2026-03-24T00:00:00Z",
            updatedAt: "2026-03-24T00:00:00Z",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    const subscription = await repositories.plans.getCurrentSubscription();

    expect(subscription).toEqual({
      tier: "plus",
      code: "lite",
      status: "active",
      currentPeriodStart: "2026-03-24T00:00:00Z",
      currentPeriodEnd: "2026-04-24T00:00:00Z",
      createdAt: "2026-03-24T00:00:00Z",
      updatedAt: "2026-03-24T00:00:00Z",
    });
  });

  it("clears the stored bearer token after sign out", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    await repositories.auth.signOut();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("treats unauthorized sign out as already signed out and clears the stored token", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "unauthorized",
          message: "未登录或登录已失效。",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://lightclaw.tech");
    await expect(repositories.auth.signOut()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("does not broadcast an unauthorized event when getSession returns 401", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "unauthorized",
          message: "未登录或登录已失效。",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);

    const repositories = createHttpRepositories("https://lightclaw.tech");

    await expect(repositories.auth.getSession()).resolves.toBeNull();
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();

    window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  });

  it("broadcasts an unauthorized event and clears the stored token on protected 401 responses", async () => {
    writeStoredAuthToken("persisted-bearer-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "unauthorized",
          message: "未登录或登录已失效。",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);

    const repositories = createHttpRepositories("https://lightclaw.tech");

    await expect(repositories.auth.getProfile()).rejects.toMatchObject({ status: 401 });
    expect(window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  });

  it("uses the live auth backend on the production pages domain even without an explicit env var", () => {
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "");
    stubHostname("lightclaw.pages.dev");

    const repositories = createRepositories();

    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("qq"),
      "https://lightclaw.tech/auth/oauth/qq/start",
      "https://lightclaw.pages.dev/auth/sign-in",
    );
    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("wechat"),
      "https://lightclaw.tech/auth/oauth/wechat/start",
      "https://lightclaw.pages.dev/auth/sign-in",
    );
  });

  it("uses the live auth backend on the primary site domain even without an explicit env var", () => {
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "");
    stubHostname("lightclaw.tech");

    const repositories = createRepositories();

    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("qq"),
      "https://lightclaw.tech/auth/oauth/qq/start",
      "https://lightclaw.tech/auth/sign-in",
    );
    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("wechat"),
      "https://lightclaw.tech/auth/oauth/wechat/start",
      "https://lightclaw.tech/auth/sign-in",
    );
  });

  it("uses the site-family auth backend on the site domain even without an explicit env var", () => {
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "");
    stubHostname("lightclaw.site");

    const repositories = createRepositories();

    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("qq"),
      "https://api.lightclaw.site/auth/oauth/qq/start",
      "https://lightclaw.site/auth/sign-in",
    );
    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("wechat"),
      "https://api.lightclaw.site/auth/oauth/wechat/start",
      "https://lightclaw.site/auth/sign-in",
    );
  });

  it("uses the lightvela auth backend on the lightvela domain even without an explicit env var", () => {
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "");
    stubHostname("lightvela.tencent.com");

    const repositories = createRepositories();

    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("qq"),
      "https://api.lightvela.tencent.com/auth/oauth/qq/start",
      "https://lightvela.tencent.com/auth/sign-in",
    );
    expectOAuthStartURL(
      repositories.auth.getOAuthStartUrl("wechat"),
      "https://api.lightvela.tencent.com/auth/oauth/wechat/start",
      "https://lightvela.tencent.com/auth/sign-in",
    );
  });
});
