import type { UserInputQuestion } from "./timeline";

export interface UserInputQuestionDraft {
  readonly selectedOptionIds?: readonly string[];
  readonly selectedOptionId: string | null;
  readonly freeformText: string;
}

/** Single-select starts on its first choice; multi-select starts empty. */
export function createUserInputQuestionDrafts(
  questions: readonly UserInputQuestion[],
): readonly UserInputQuestionDraft[] {
  return questions.map((question) => ({
    selectedOptionId: question.multiSelect ? null : question.options[0]?.id ?? null,
    ...(question.multiSelect ? { selectedOptionIds: [] } : {}),
    freeformText: "",
  }));
}

export function resolveUserInputQuestionDraft(
  question: UserInputQuestion,
  draft: UserInputQuestionDraft | undefined,
): string | null {
  const selectedOption = question.options.find((option) => option.id === draft?.selectedOptionId);
  const selectedValue = selectedOption?.label.trim() ?? "";
  if (selectedValue.length > 0) return selectedValue;
  if (!question.isOther && question.options.length > 0) return null;
  const freeformValue = draft?.freeformText.trim() ?? "";
  return freeformValue.length > 0 ? freeformValue : null;
}

/**
 * Builds the renderer-neutral answer map consumed by the AppServer adapter.
 * Empty/skipped questions are omitted.
 */
export function aggregateUserInputQuestionAnswers(
  questions: readonly UserInputQuestion[],
  drafts: readonly UserInputQuestionDraft[],
): Readonly<Record<string, readonly string[]>> {
  const answers: Record<string, readonly string[]> = {};
  questions.forEach((question, index) => {
    if (question.multiSelect) {
      const draft = drafts[index];
      const selected = question.options.filter(option => draft?.selectedOptionIds?.includes(option.id)).map(option => option.label);
      const custom = draft?.freeformText.trim();
      if (custom && (question.isOther || question.options.length === 0)) selected.push(custom);
      if (selected.length) answers[question.id] = selected;
      return;
    }
    const answer = resolveUserInputQuestionDraft(question, drafts[index]);
    if (answer !== null) answers[question.id] = [answer];
  });
  return answers;
}

/** Both renderers share selection behavior; multi-select never advances on a toggle. */
export function selectUserInputQuestionOption(question: UserInputQuestion, draft: UserInputQuestionDraft | undefined, optionId: string): UserInputQuestionDraft {
  if (!question.multiSelect) return { selectedOptionId: optionId, freeformText: draft?.freeformText ?? "" };
  const prior = draft?.selectedOptionIds ?? [];
  return { selectedOptionId: null, selectedOptionIds: prior.includes(optionId) ? prior.filter(id => id !== optionId) : [...prior, optionId], freeformText: draft?.freeformText ?? "" };
}

/** Parse client-owned question fields outside the generated request schema. */
export function userInputQuestionExtensions(value: unknown): Pick<UserInputQuestion, "multiSelect" | "detail" | "intent"> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const intent = input.intent as { kind?: unknown; approve?: unknown } | null;
  return {
    ...(typeof input.multiSelect === "boolean" ? { multiSelect: input.multiSelect } : {}),
    ...(typeof input.detail === "string" ? { detail: input.detail } : {}),
    ...(intent?.kind === "plan-review" && typeof intent.approve === "string" ? { intent: { kind: "plan-review" as const, approve: intent.approve } } : {}),
  };
}
