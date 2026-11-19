import { digest, stable, requireText } from "./values.mjs";

export const CONTEXT_POLICY = Object.freeze({
  keepRecent: 20,
  minMessages: 8,
  batchMessages: 16,
  segmentCharacters: 4000,
  batchCharacters: 16000,
  summaryBytes: 24000,
  timeoutMs: 30000,
  maxAttempts: 3,
});
export const CONTEXT_SECTIONS = Object.freeze([
  "goals",
  "constraints",
  "decisions",
  "openItems",
]);
export const emptyContext = () =>
  Object.fromEntries(CONTEXT_SECTIONS.map((k) => [k, []]));
export const contextHash = (value) => digest(value);

/** A cited, lossy projection. Citations establish origin, not semantic correctness or authority. */
export function parseContext(raw, input) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !CONTEXT_SECTIONS.includes(k))
  )
    throw new Error("Invalid conversation context sections");
  const allowed = new Map(
    (input.previous?.sources ?? []).map((s) => [s.id, s]),
  );
  for (const m of input.messages) allowed.set(m.id, { id: m.id, role: m.role });
  const used = new Map();
  const result = Object.fromEntries(
    CONTEXT_SECTIONS.map((k) => {
      if (!Array.isArray(raw[k]) || raw[k].length > 8)
        throw new Error("Conversation context section exceeds 8 items");
      return [
        k,
        raw[k].map((item) => {
          if (
            !item ||
            Object.keys(item).some((x) => !["text", "sourceIds"].includes(x))
          )
            throw new Error("Invalid context item");
          const text = requireText(item.text, "context item", 400);
          if (
            !Array.isArray(item.sourceIds) ||
            item.sourceIds.length < 1 ||
            item.sourceIds.length > 4 ||
            new Set(item.sourceIds).size !== item.sourceIds.length ||
            item.sourceIds.some((id) => !allowed.has(id))
          )
            throw new Error("Context citation is outside the captured history");
          for (const id of item.sourceIds) used.set(id, allowed.get(id));
          return { text, sourceIds: [...item.sourceIds] };
        }),
      ];
    }),
  );
  const value = {
    ...result,
    sources: [...used.values()],
    semanticReview: "unverified",
  };
  if (Buffer.byteLength(stable(value), "utf8") > CONTEXT_POLICY.summaryBytes)
    throw new Error("Conversation context exceeds byte bound");
  return value;
}
