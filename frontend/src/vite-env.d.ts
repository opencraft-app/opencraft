/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_API_BASE_URL?: string;
  readonly VITE_OAUTH_RELAY_ISSUER_BASE_URL?: string;
  readonly VITE_AEGIS_ENABLED?: string;
  readonly VITE_AEGIS_ID?: string;
  readonly VITE_AEGIS_HOST_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
