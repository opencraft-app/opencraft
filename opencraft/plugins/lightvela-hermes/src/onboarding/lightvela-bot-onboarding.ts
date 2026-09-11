import {
  LIGHTVELA_REGIONS,
  type LightVelaAccountPhase,
  type LightVelaRegion,
} from "../account/lightvela-account-contract";

export type LightVelaBotOnboardingState =
  | { readonly kind: "loading" }
  | { readonly kind: "sign-in-required"; readonly error: string | null }
  | { readonly kind: "bot-required"; readonly createUrl: string }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly error: string };

export interface LightVelaBotOnboardingInput {
  readonly region: LightVelaRegion;
  readonly phase: LightVelaAccountPhase;
  readonly botCount: number;
  readonly error: string | null;
}

/**
 * Renderer-neutral account → application-entry projection. A missing Bot is a
 * valid authenticated state, not a connection failure and not a Host state.
 */
export function projectLightVelaBotOnboarding(
  input: LightVelaBotOnboardingInput,
): LightVelaBotOnboardingState {
  if (!Number.isInteger(input.botCount) || input.botCount < 0) {
    throw new RangeError("LightVela Bot count must be a non-negative integer");
  }
  if (input.phase === "loading") return Object.freeze({ kind: "loading" });
  if (input.phase === "anonymous") {
    return Object.freeze({ kind: "sign-in-required", error: input.error });
  }
  if (input.phase === "error") {
    return Object.freeze({
      kind: "error",
      error: input.error?.trim() || "Could not load the LightVela account",
    });
  }
  if (input.botCount === 0) {
    return Object.freeze({
      kind: "bot-required",
      createUrl: lightVelaBotCreationUrl(input.region),
    });
  }
  return Object.freeze({ kind: "ready" });
}

export function lightVelaBotCreationUrl(region: LightVelaRegion): string {
  return new URL("/dashboard/create", LIGHTVELA_REGIONS[region].frontendBase).toString();
}
