/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_API_BASE_URL?: string;
  readonly VITE_OAUTH_RELAY_ISSUER_BASE_URL?: string;
  readonly VITE_AEGIS_ENABLED?: string;
  readonly VITE_AEGIS_ID?: string;
  readonly VITE_AEGIS_HOST_URL?: string;
  readonly VITE_POSTHOG_ENABLED?: string;
  readonly VITE_POSTHOG_PROJECT_TOKEN?: string;
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_POSTHOG_UI_HOST?: string;
  readonly NEXT_PUBLIC_POSTHOG_ENABLED?: string;
  readonly NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
  readonly NEXT_PUBLIC_POSTHOG_HOST?: string;
  readonly NEXT_PUBLIC_POSTHOG_UI_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
