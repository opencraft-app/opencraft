import { modelRequest } from "./model-request.mjs";
import { MEMORY_PROPOSE_INSTRUCTION, MEMORY_VERIFY_INSTRUCTION, memoryModelInput } from "./memory-model-contract.mjs";
/** Separate proposal and review calls; neither receives commands or persistence. */
export class MemoryLearningModel {
  constructor(catalog, options = {}) {
    this.catalog = catalog;
    this.options = options;
  }
  async call(instruction, input, signal, kind = "memory-propose") {
    const answer = await modelRequest(this.catalog, kind, instruction, input, signal, {
      ...this.options,
      maxTokens: kind === "memory-propose" ? 16384 : 1800,
    });
    if (["error", "aborted"].includes(answer.stopReason)) throw new Error(answer.errorMessage ?? "Memory model failed");
    return JSON.parse(
      answer.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim()
        .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"),
    );
  }
  async propose(input, signal) {
    if (this.catalog.configured.mode === "fixture") {
      const e = input.evidence.find((e) => e.role === "user" && e.text.includes("我喜欢简短回答"));
      return {
        changes:
          e && !input.snapshot.facts?.some((f) => f.content === "简短回答")
            ? [
                {
                  action: "create",
                  content: "简短回答",
                  kind: "profile",
                  sourceEvidenceIds: [e.id],
                },
              ]
            : [],
      };
    }
    return this.call(MEMORY_PROPOSE_INSTRUCTION, memoryModelInput(input), signal, "memory-propose");
  }
  async verify(input, signal) {
    if (this.catalog.configured.mode === "fixture")
      return {
        approved: input.proposal.changes.every(
          (c) =>
            c.action === "create" &&
            c.content === "简短回答" &&
            c.sourceEvidenceIds.every((id) =>
              input.evidence.some((e) => e.id === id && e.role === "user" && e.text.includes("我喜欢简短回答")),
            ),
        ),
      };
    return this.call(MEMORY_VERIFY_INSTRUCTION, memoryModelInput(input, true), signal, "memory-verify");
  }
}
