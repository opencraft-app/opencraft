import { userMessage } from "./user-message.mjs";
import { requireText } from "./values.mjs";

/** A system report may suggest a next step, never invent a new user instruction. */
export class ContinuationDecision {
  static maxContinuations = 3;
  static parse(raw) {
    if (
      !raw ||
      !["deliver", "continue", "silent", "blocked"].includes(raw.kind)
    )
      throw new Error("Unsupported continuation decision");
    const value = { kind: raw.kind };
    if (raw.goalPlan && raw.goalReview)
      throw new Error(
        "Cannot extend and complete the same plan in one decision",
      );
    for (const field of ["goalPlan", "goalReview"])
      if (raw[field] !== undefined) {
        if (raw.kind !== "deliver")
          throw new Error("Goal decisions require an accepted delivery result");
        value[field] = raw[field];
      }
    if (raw.message !== undefined) {
      if (raw.text !== undefined)
        throw new Error("Use either text or message for a final delivery");
      if (raw.kind !== "deliver")
        throw new Error("Only final delivery can carry a message");
      value.message = userMessage(raw.message);
      value.text =
        value.message.type === "text" ? value.message.content : "附件结果";
    }
    if (raw.finishRoutine !== undefined) {
      if (
        typeof raw.finishRoutine !== "boolean" ||
        !["deliver", "silent"].includes(raw.kind)
      )
        throw new Error(
          "finishRoutine is only valid on a final result decision",
        );
      value.finishRoutine = raw.finishRoutine;
    }
    if (raw.kind === "continue")
      value.goal = requireText(raw.goal, "continuation goal");
    if (
      raw.kind === "blocked" ||
      (raw.kind === "deliver" && raw.text !== undefined)
    )
      value.text = requireText(raw.text, "response", 10000);
    return value;
  }
}
