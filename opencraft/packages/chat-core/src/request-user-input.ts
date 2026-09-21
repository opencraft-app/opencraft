import type { UserInputQuestion } from "./timeline";

export interface UserInputQuestionDraft {
  readonly selectedOptionId: string | null;
  readonly freeformText: string;
}

/** Mirrors Codex RequestInputPanel: an option question starts on its first choice. */
export function createUserInputQuestionDrafts(
  questions: readonly UserInputQuestion[],
): readonly UserInputQuestionDraft[] {
  return questions.map((question) => ({
    selectedOptionId: question.options[0]?.id ?? null,
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
 * Empty/skipped questions are omitted, matching Codex aggregateSurveyResponses.
 */
export function aggregateUserInputQuestionAnswers(
  questions: readonly UserInputQuestion[],
  drafts: readonly UserInputQuestionDraft[],
): Readonly<Record<string, readonly string[]>> {
  const answers: Record<string, readonly string[]> = {};
  questions.forEach((question, index) => {
    const answer = resolveUserInputQuestionDraft(question, drafts[index]);
    if (answer !== null) answers[question.id] = [answer];
  });
  return answers;
}
