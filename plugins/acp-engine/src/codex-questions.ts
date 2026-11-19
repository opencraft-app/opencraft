import type { ToolRequestUserInputQuestion } from "@opencraft/appserver-protocol/generated/v2";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function codexMeta(value: Record<string, unknown>) {
  return record(record(value._meta)?.codex);
}

/** Only recognized Codex user questions go through this lane. MCP tool
 * approvals and unrelated forms cannot turn into a user-input response. */
export function parseCodexQuestionForm(params: Record<string, unknown>) {
  const metadata = codexMeta(params);
  if (params.mode !== "form" || !metadata
    || (metadata.delivery !== "async" && !Object.hasOwn(metadata, "autoResolutionMs"))) return null;
  const schema = record(params.requestedSchema);
  const properties = record(schema?.properties);
  if (schema?.type !== "object" || !properties || Object.keys(properties).length > 32) return null;

  const questions: ToolRequestUserInputQuestion[] = [];
  const notes = new Map<string, string>();
  const otherChoices = new Set<string>();
  for (const [id, raw] of Object.entries(properties)) {
    const property = record(raw);
    const field = property && codexMeta(property);
    if (!field || property?.type !== "string" || field.isSecret !== false || !id || id.length > 256) return null;
    if (field.role === "user_note") {
      if (typeof field.questionId !== "string" || notes.has(field.questionId)) return null;
      notes.set(field.questionId, id);
      continue;
    }
    if (typeof field.isOther !== "boolean" || typeof property.title !== "string" || !property.title.trim() || property.title.length > 4096) return null;
    const options: NonNullable<ToolRequestUserInputQuestion["options"]> = [];
    if (property.oneOf !== undefined) {
      if (!Array.isArray(property.oneOf) || property.oneOf.length > 32) return null;
      for (const rawOption of property.oneOf) {
        const option = record(rawOption);
        if (!option || typeof option.const !== "string" || !option.const.trim() || option.const.length > 512) return null;
        if (field.isOther && option.const === "None of the above" && option.description === "Provide a different answer in the note field.") {
          otherChoices.add(id);
          continue;
        }
        options.push({ label: option.const, description: typeof option.description === "string" ? option.description.slice(0, 2048) : "" });
      }
      if (options.length === 0 || new Set(options.map(option => option.label.trim())).size !== options.length) return null;
    }
    questions.push({ id, header: typeof property.description === "string" ? property.description.slice(0, 2048) : "",
      question: property.title, isOther: field.isOther, isSecret: false,
      options: property.oneOf === undefined ? null : options });
  }
  if (questions.length === 0 || [...notes.keys()].some(id => !questions.some(question => question.id === id && question.isOther && question.options))
    || questions.some(question => question.isOther && question.options && !notes.has(question.id))) return null;

  return {
    questions,
    isBlocking: metadata.delivery !== "async",
    reply(result: Record<string, unknown>) {
      const answers = record(result.answers);
      if (!answers) throw new Error("Invalid question response");
      const content: [string, string][] = [];
      for (const [id, raw] of Object.entries(answers)) {
        const question = questions.find(entry => entry.id === id);
        const values = record(raw)?.answers;
        if (!question || !Array.isArray(values) || values.length !== 1
          || typeof values[0] !== "string" || !values[0].trim() || values[0].length > 64 * 1024) {
          throw new Error("Invalid question answer");
        }
        const answer = values[0];
        const choice = question.options?.find(option => option.label.trim() === answer);
        if (!question.options || choice) content.push([id, choice?.label ?? answer]);
        else {
          const note = notes.get(id);
          if (!question.isOther || note === undefined) throw new Error("Answer is not an offered choice");
          if (otherChoices.has(id)) content.push([id, "None of the above"]);
          content.push([note, answer]);
        }
      }
      return content.length ? { action: "accept", content: Object.fromEntries(content) } : { action: "cancel" };
    },
  };
}
