import { readStoredCookieConsent, type CookieConsentValue } from "@/lib/cookie-consent";
import { REGION, type Region } from "@/lib/region";

type PostHogEnv = {
  readonly PROD?: boolean;
  readonly NODE_ENV?: string;
  readonly NEXT_PUBLIC_POSTHOG_ENABLED?: string;
  readonly NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
  readonly NEXT_PUBLIC_POSTHOG_HOST?: string;
  readonly NEXT_PUBLIC_POSTHOG_UI_HOST?: string;
  readonly VITE_POSTHOG_ENABLED?: string;
  readonly VITE_POSTHOG_PROJECT_TOKEN?: string;
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_POSTHOG_UI_HOST?: string;
};

type PostHogModule = typeof import("posthog-js");
type PostHogClient = PostHogModule["default"];
type PostHogImportShape = {
  default?: unknown;
  posthog?: unknown;
};

export type PostHogConfig = {
  projectToken: string;
  host: string;
  uiHost?: string;
  region: Region;
};

export type ProductAnalyticsEvent =
  | "landing_cta_clicked"
  | "login_modal_opened"
  | "oauth_provider_clicked"
  | "subscribe_cta_clicked"
  | "agent_create_started"
  | "agent_create_succeeded"
  | "agent_create_failed";

export type ProductAnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

let posthog: PostHogClient | null = null;
let initPromise: Promise<PostHogClient | null> | null = null;
let pendingUserId: string | undefined;
let identifiedUserId: string | undefined;
let activeRegion: Region | undefined;

const isTruthy = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const cleanOptionalUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const readImportMetaEnv = (): PostHogEnv => {
  try {
    return import.meta.env ?? {};
  } catch {
    return {};
  }
};

const readPostHogEnv = (): PostHogEnv => ({
  ...readImportMetaEnv(),
  NEXT_PUBLIC_POSTHOG_ENABLED: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POSTHOG_ENABLED : undefined,
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN : undefined,
  NEXT_PUBLIC_POSTHOG_HOST: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POSTHOG_HOST : undefined,
  NEXT_PUBLIC_POSTHOG_UI_HOST: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POSTHOG_UI_HOST : undefined,
  NODE_ENV: typeof process !== "undefined" ? process.env.NODE_ENV : undefined,
});

const envValue = (
  env: PostHogEnv,
  nextKey: keyof PostHogEnv,
  viteKey: keyof PostHogEnv,
): string | undefined => {
  const nextValue = env[nextKey];
  if (typeof nextValue === "string" && nextValue.trim()) return nextValue;
  const viteValue = env[viteKey];
  return typeof viteValue === "string" ? viteValue : undefined;
};

const readClientMember = (value: unknown, key: keyof PostHogClient): unknown => {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Partial<Record<keyof PostHogClient, unknown>>)[key];
  } catch {
    return undefined;
  }
};

const isPostHogClient = (value: unknown): value is PostHogClient => {
  if (!value || typeof value !== "object") return false;
  return (
    typeof readClientMember(value, "init") === "function" &&
    typeof readClientMember(value, "capture") === "function" &&
    typeof readClientMember(value, "identify") === "function" &&
    typeof readClientMember(value, "reset") === "function" &&
    typeof readClientMember(value, "opt_out_capturing") === "function" &&
    typeof readClientMember(value, "opt_in_capturing") === "function" &&
    typeof readClientMember(value, "has_opted_out_capturing") === "function"
  );
};

const readImportMember = (value: unknown, key: "default" | "posthog"): unknown => {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as PostHogImportShape)[key];
  } catch {
    return undefined;
  }
};

export function resolvePostHogClient(sdk: unknown): PostHogClient | null {
  const firstDefault = readImportMember(sdk, "default");
  const candidates = [
    sdk,
    firstDefault,
    readImportMember(sdk, "posthog"),
    readImportMember(firstDefault, "default"),
    readImportMember(firstDefault, "posthog"),
  ];
  return candidates.find(isPostHogClient) ?? null;
}

export function resolvePostHogConfig(
  env: PostHogEnv = readPostHogEnv(),
  region: Region = REGION,
  consent: CookieConsentValue | null = readStoredCookieConsent(),
): PostHogConfig | null {
  const isProduction = env.PROD === true || env.NODE_ENV === "production";
  if (!isProduction || region !== "global" || consent !== "accepted") {
    return null;
  }

  if (!isTruthy(envValue(env, "NEXT_PUBLIC_POSTHOG_ENABLED", "VITE_POSTHOG_ENABLED"))) {
    return null;
  }

  const projectToken = envValue(env, "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "VITE_POSTHOG_PROJECT_TOKEN")?.trim() ?? "";
  const host = envValue(env, "NEXT_PUBLIC_POSTHOG_HOST", "VITE_POSTHOG_HOST")?.trim() ?? "";
  if (!projectToken || !host) {
    return null;
  }

  return {
    projectToken,
    host,
    uiHost: cleanOptionalUrl(envValue(env, "NEXT_PUBLIC_POSTHOG_UI_HOST", "VITE_POSTHOG_UI_HOST")),
    region,
  };
}

export async function initPostHog(
  env: PostHogEnv = readPostHogEnv(),
  region: Region = REGION,
  consent: CookieConsentValue | null = readStoredCookieConsent(),
): Promise<PostHogClient | null> {
  if (posthog) {
    // Re-acceptance path: a prior disablePostHog() opted the client out.
    // initPostHog() is a no-op short-circuit, so opt back in here, otherwise
    // every subsequent capture() is silently dropped while consent is accepted.
    if (posthog.has_opted_out_capturing()) {
      posthog.opt_in_capturing();
    }
    applyPendingUser();
    return posthog;
  }
  if (initPromise) return initPromise;

  const config = resolvePostHogConfig(env, region, consent);
  if (!config) return null;

  initPromise = import("posthog-js")
    .then((sdk: PostHogModule) => {
      const client = resolvePostHogClient(sdk);
      if (!client) {
        throw new Error("PostHog SDK did not expose a supported browser client");
      }

      client.init(config.projectToken, {
        api_host: config.host,
        ui_host: config.uiHost,
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
        property_denylist: [
          "email",
          "phone",
          "mobile",
          "password",
          "token",
          "authorization",
          "inviteCode",
          "invite_code",
        ],
        loaded: (client) => {
          client.register({
            app_region: config.region,
            app_surface: "lightvela-web",
          });
        },
      });

      posthog = client;
      activeRegion = config.region;
      applyPendingUser();
      return posthog;
    })
    .catch((error: unknown) => {
      console.warn("Failed to initialize PostHog analytics", error);
      initPromise = null;
      return null;
    });

  return initPromise;
}

function applyPendingUser(): void {
  if (!posthog) return;
  if (!pendingUserId) {
    if (identifiedUserId) {
      posthog.reset();
      identifiedUserId = undefined;
    }
    return;
  }

  if (identifiedUserId === pendingUserId) return;
  posthog.identify(pendingUserId, {
    app_region: activeRegion ?? REGION,
  });
  identifiedUserId = pendingUserId;
}

export function setPostHogUser(userId: string | null | undefined): void {
  pendingUserId = userId || undefined;
  applyPendingUser();
}

export function disablePostHog(): void {
  // Retain pendingUserId: it mirrors the current session user (kept in sync by
  // setPostHogUser) and must survive a consent toggle so the user is
  // re-identified on re-acceptance. Only the SDK side is opted out + reset.
  identifiedUserId = undefined;
  posthog?.opt_out_capturing();
  posthog?.reset();
}

/**
 * Explicit product event capture.
 *
 * Note: `property_denylist` in the init config only filters *autocaptured*
 * events, and autocapture is disabled here. Calls to this function bypass the
 * denylist, so callers MUST NOT pass PII (emails, phone numbers, tokens,
 * invite codes, etc.) — keep properties to enums / ids / booleans / counters.
 */
export function captureProductEvent(
  eventName: ProductAnalyticsEvent,
  properties?: ProductAnalyticsProperties,
): void {
  posthog?.capture(eventName, {
    ...properties,
    app_region: activeRegion ?? REGION,
    app_surface: "lightvela-web",
  });
}

export function resetPostHogForTest(): void {
  posthog = null;
  initPromise = null;
  pendingUserId = undefined;
  identifiedUserId = undefined;
  activeRegion = undefined;
}
