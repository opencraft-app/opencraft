/** Renderer-neutral LightVela account vocabulary shared by Web and Expo. */
export type LightVelaRegion = "cn" | "intl";

export const LIGHTVELA_REGIONS = {
  cn: {
    label: "国内版 · lightvela.com",
    apiBase: "https://api.lightvela.com",
    frontendBase: "https://lightvela.com",
  },
  intl: {
    label: "国际版 · lightvela.ai",
    apiBase: "https://api.lightvela.ai",
    frontendBase: "https://lightvela.ai",
  },
} as const;

export type LightVelaAccountPhase =
  | "anonymous"
  | "loading"
  | "authenticated"
  | "error";

export interface LightVelaBotInstance {
  readonly createdAt: string;
  readonly instanceId: string;
  readonly name: string;
  /** The account catalog contains only executable instances. */
  readonly status: "running";
}
