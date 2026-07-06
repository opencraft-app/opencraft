interface ImportMetaEnv {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly VITE_REGION?: "cn" | "global";
  readonly VITE_AUTH_API_BASE_URL?: string;
  readonly VITE_PAID_BILLING_ENABLED?: string;
  readonly VITE_LOCAL_PREVIEW_AUTH?: string;
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

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_WECHAT_PAY_AUTH_BASE_URL?: string;
    readonly NEXT_PUBLIC_WX_BUY_HOST?: string;
    readonly NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL?: string;
    readonly NEXT_PUBLIC_WX_PAY_PROCESS_VERSION?: string;
    readonly NEXT_PUBLIC_WX_PAY_PRODUCT_ID?: string;
    readonly NEXT_PUBLIC_MIDAS_SANDBOX?: string;
    readonly NEXT_PUBLIC_PAID_BILLING_ENABLED?: string;
  }
}
