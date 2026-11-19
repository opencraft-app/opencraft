/** The model chosen in onboarding is the next new conversation's default. */
export function onboardingNewThreadSelection(modelId: string | undefined): {
  readonly model: string;
  readonly effort: null;
  readonly serviceTier: null;
} | null {
  const model = modelId?.trim();
  if (!model) return null;
  return { model, effort: null, serviceTier: null };
}
