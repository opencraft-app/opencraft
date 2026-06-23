import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureProductEvent,
  disablePostHog,
  initPostHog,
  resolvePostHogClient,
  resetPostHogForTest,
  resolvePostHogConfig,
  setPostHogUser,
} from "@/observability/posthog";

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  optOutCapturing: vi.fn(),
  optInCapturing: vi.fn(),
  hasOptedOutCapturing: vi.fn(() => false),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: posthogMock.init,
    register: posthogMock.register,
    identify: posthogMock.identify,
    reset: posthogMock.reset,
    capture: posthogMock.capture,
    opt_out_capturing: posthogMock.optOutCapturing,
    opt_in_capturing: posthogMock.optInCapturing,
    has_opted_out_capturing: posthogMock.hasOptedOutCapturing,
  },
}));

describe("resolvePostHogClient", () => {
  it("accepts nested PostHog SDK default exports", () => {
    const client = {
      init: vi.fn(),
      register: vi.fn(),
      identify: vi.fn(),
      reset: vi.fn(),
      capture: vi.fn(),
      opt_out_capturing: vi.fn(),
      opt_in_capturing: vi.fn(),
      has_opted_out_capturing: vi.fn(),
    };

    expect(resolvePostHogClient({ default: { default: client } })).toBe(client);
  });
});

describe("resolvePostHogConfig", () => {
  it("requires production, global region, accepted consent, explicit enablement, token, and host", () => {
    expect(resolvePostHogConfig({
      PROD: false,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted")).toBeNull();

    expect(resolvePostHogConfig({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "cn", "accepted")).toBeNull();

    expect(resolvePostHogConfig({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "necessary")).toBeNull();

    expect(resolvePostHogConfig({
      PROD: true,
      VITE_POSTHOG_ENABLED: "false",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted")).toBeNull();

    expect(resolvePostHogConfig({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
    }, "global", "accepted")).toBeNull();
  });

  it("resolves global PostHog release config", () => {
    expect(resolvePostHogConfig({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
      VITE_POSTHOG_UI_HOST: "https://us.posthog.com",
    }, "global", "accepted")).toEqual({
      projectToken: "ph_test",
      host: "https://us.i.posthog.com",
      uiHost: "https://us.posthog.com",
      region: "global",
    });
  });

  it("resolves Next public PostHog env names", () => {
    expect(resolvePostHogConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_POSTHOG_ENABLED: "true",
      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "ph_next",
      NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
      NEXT_PUBLIC_POSTHOG_UI_HOST: "https://eu.posthog.com",
    }, "global", "accepted")).toEqual({
      projectToken: "ph_next",
      host: "https://eu.i.posthog.com",
      uiHost: "https://eu.posthog.com",
      region: "global",
    });
  });
});

describe("initPostHog", () => {
  beforeEach(() => {
    resetPostHogForTest();
    vi.clearAllMocks();
    posthogMock.init.mockImplementation((_token: string, config: { loaded?: (client: unknown) => void }) => {
      config.loaded?.({
        register: posthogMock.register,
      });
    });
  });

  it("initializes PostHog with conservative product analytics defaults", async () => {
    await initPostHog({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted");

    expect(posthogMock.init).toHaveBeenCalledWith("ph_test", expect.objectContaining({
      api_host: "https://us.i.posthog.com",
      defaults: "2026-01-30",
      capture_pageview: "history_change",
      autocapture: false,
      person_profiles: "identified_only",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      disable_session_recording: true,
      disable_surveys: true,
      enable_heatmaps: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
    }));
    expect(posthogMock.register).toHaveBeenCalledWith({
      app_region: "global",
      app_surface: "lightvela-web",
    });
  });

  it("applies pending user id after lazy initialization and resets on logout", async () => {
    setPostHogUser("usr_123");
    await initPostHog({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted");

    expect(posthogMock.identify).toHaveBeenCalledWith("usr_123", {
      app_region: "global",
    });

    setPostHogUser(null);
    expect(posthogMock.reset).toHaveBeenCalledTimes(1);
  });

  it("captures only through the explicit product event API", async () => {
    await initPostHog({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted");

    captureProductEvent("subscribe_cta_clicked", {
      plan: "pro",
    });

    expect(posthogMock.capture).toHaveBeenCalledWith("subscribe_cta_clicked", {
      plan: "pro",
      app_region: "global",
      app_surface: "lightvela-web",
    });
  });

  it("opts back in and re-identifies on re-acceptance after a disable", async () => {
    setPostHogUser("usr_123");
    await initPostHog({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted");
    expect(posthogMock.identify).toHaveBeenCalledWith("usr_123", { app_region: "global" });
    expect(posthogMock.optInCapturing).not.toHaveBeenCalled();

    // User withdraws consent: opt out + reset, but pendingUserId is retained.
    disablePostHog();
    expect(posthogMock.optOutCapturing).toHaveBeenCalledTimes(1);
    expect(posthogMock.reset).toHaveBeenCalled();

    // Re-acceptance: initPostHog short-circuits on the existing client, so it
    // must explicitly opt back in, otherwise captures stay silently dropped.
    posthogMock.hasOptedOutCapturing.mockReturnValue(true);
    await initPostHog({
      PROD: true,
      VITE_POSTHOG_ENABLED: "true",
      VITE_POSTHOG_PROJECT_TOKEN: "ph_test",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    }, "global", "accepted");

    expect(posthogMock.optInCapturing).toHaveBeenCalledTimes(1);
    // Pending user identity survives the consent toggle and is re-applied.
    expect(posthogMock.identify).toHaveBeenCalledTimes(2);
    expect(posthogMock.identify).toHaveBeenLastCalledWith("usr_123", { app_region: "global" });

    // Captures now flow again.
    captureProductEvent("subscribe_cta_clicked");
    expect(posthogMock.capture).toHaveBeenCalled();
  });
});
