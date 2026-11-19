import { requireText, digest } from "./values.mjs";

/** Measurable checks are distinct from semantic expectations, which remain unverified. */
export class CompletionContract {
  static replacement(objective, raw) {
    if (
      !raw ||
      !["note", "text"].includes(raw.output) ||
      !Array.isArray(raw.requirements) ||
      !Array.isArray(raw.checks)
    )
      throw new Error("Amend requires a complete completion contract: output, requirements, checks");
    return this.create(objective, raw);
  }
  static create(objective, raw = {}) {
    requireText(objective, "objective");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid completion contract");
    const requirements = raw.requirements ?? [];
    if (!Array.isArray(requirements) || requirements.length > 16) throw new Error("At most 16 semantic requirements");
    const checks = raw.checks ?? [];
    if (!Array.isArray(checks) || checks.length > 16) throw new Error("At most 16 completion checks");
    const normalized = checks.map((c, index) => {
      if (!c || !["note_published", "material_read", "note_contains"].includes(c.kind))
        throw new Error("Unsupported completion check");
      const value = { id: `check-${index + 1}`, kind: c.kind };
      if (c.kind === "material_read") {
        value.path = requireText(c.path, "material path", 1000);
        if (
          value.path.startsWith("/") ||
          value.path.includes("\\") ||
          value.path.split("/").some((p) => !p || p === "." || p === "..")
        )
          throw new Error("Completion material path must be relative and normalized");
        if (c.sha256 !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(c.sha256)) throw new Error("Expected SHA256 must be 64 lowercase hex characters");
          value.sha256 = c.sha256;
        }
      }
      if (c.kind === "note_contains") value.text = requireText(c.text, "literal text", 1000);
      return value;
    });
    const output = raw.output ?? "note";
    if (!["note", "text"].includes(output)) throw new Error("Unsupported work output");
    if (output === "note" && !normalized.some((c) => c.kind === "note_published"))
      normalized.unshift({ id: "note", kind: "note_published" });
    if (normalized.length > 16) throw new Error("At most 16 checks including required note publication");
    return {
      schema: 2,
      output,
      objective,
      requirements: requirements.map((x) => requireText(x, "semantic requirement", 1000)),
      checks: normalized,
      delivery: {
        destination: "local-mailbox",
        requiredAcceptance: "local-file-accepted",
      },
      origin: "current",
    };
  }
  static forWork(work) {
    return work.completion_json
      ? JSON.parse(work.completion_json)
      : {
          schema: 1,
          objective: work.text,
          requirements: [],
          checks: [],
          delivery: {
            destination: "local-mailbox",
            requiredAcceptance: "local-file-accepted",
          },
          origin: "legacy",
        };
  }
  static evaluate(contract, evidence, result) {
    const checks = contract.checks.map((c) => {
      const receipt = evidence.find((e) =>
        c.kind === "material_read"
          ? e.kind === "material.read" && e.data.path === c.path && (!c.sha256 || e.data.sha256 === c.sha256)
          : e.kind === "note.published" && (c.kind === "note_published" || e.data.literalMatches.includes(c.id)),
      );
      return {
        id: c.id,
        kind: c.kind,
        passed: !!receipt,
        evidenceId: receipt?.id ?? null,
      };
    });
    const resultPresent = typeof result === "string" && result.trim().length > 0;
    return {
      passed: resultPresent && checks.every((c) => c.passed),
      resultPresent,
      checks,
      semanticReview: "unverified",
      requirements: contract.requirements,
      contract,
      contractDigest: digest(contract),
      resultDigest: typeof result === "string" ? digest(result) : null,
    };
  }
}
