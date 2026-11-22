import { ModelCatalog } from "../adapters/models/model-catalog.mjs";
import { DirectoryKnowledgeSource } from "../adapters/filesystem/knowledge-source.mjs";
import { resolveHarnesses } from "../adapters/codex/config.mjs";
import { readCodexKey } from "../adapters/codex/credential-file.mjs";

/** Offline configuration probe. Never submits a model request or reads shared credential files. */
export async function inspectLocalConfiguration(
  profile,
  environment = process.env,
) {
  const harnesses = resolveHarnesses(profile.config);
  const { configured } =
    profile.config.mode === "model" &&
    !profile.config.model &&
    harnesses.assistant === "codex" &&
    harnesses.execution === "codex"
      ? { configured: { mode: "model" } }
      : await ModelCatalog.open(profile);
  const credentialName = {
    deepseek: "DEEPSEEK_API_KEY",
    "openai-compatible": "OPENCRAFT_EVAL_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  }[configured.model?.provider];
  const source = profile.config.workspace
    ? new DirectoryKnowledgeSource(profile.config.workspace)
    : null;
  return {
    stage: "development",
    profile: profile.path,
    assistantId: profile.config.assistantId,
    owner: profile.config.owner,
    mode: configured.mode,
    harnesses: {
      assistant: harnesses.assistant,
      execution: harnesses.execution,
    },
    executionCheckpoint:
      harnesses.execution === "codex"
        ? "Codex native thread with host-effect receipts"
        : "Pi durable",
    executionModel:
      harnesses.execution === "codex"
        ? { provider: "codex-responses", modelId: harnesses.codex.modelId }
        : (configured.model ?? { provider: "faux", modelId: "faux-1" }),
    assistantModel:
      harnesses.assistant === "codex"
        ? {
            provider: "codex-responses",
            modelId: harnesses.codex.modelId,
            credentialConfigured: !!harnesses.codex.credentialFile,
            credentialFileValid: harnesses.codex.credentialFile
              ? !!readCodexKey(harnesses.codex)
              : null,
            protocol: "Responses (not Chat Completions)",
          }
        : (configured.model ?? { provider: "faux", modelId: "faux-1" }),
    backgroundModel: harnesses.backgroundCodex
      ? {
          provider: "codex-responses",
          modelId: harnesses.backgroundCodex.modelId,
          reasoningEffort: harnesses.backgroundCodex.reasoningEffort ?? null,
          credentialFileValid: harnesses.backgroundCodex.credentialFile
            ? !!readCodexKey(harnesses.backgroundCodex)
            : null,
          roles: ["memory-propose", "memory-verify", "context-summary"],
        }
      : { inheritsAssistantModel: true },
    runPolicy: profile.config.runPolicy,
    usage: {
      source:
        "Native counters and assistant inference observations; endpoint prices remain unknown unless provided",
      billingVerified: false,
    },
    configurationValid: true,
    model:
      harnesses.assistant === "codex"
        ? { provider: "codex-responses", modelId: harnesses.codex.modelId }
        : (configured.model ?? { provider: "faux", modelId: "faux-1" }),
    credential: credentialName
      ? {
          environmentVariable: credentialName,
          present: !!environment[credentialName],
        }
      : null,
    materials: source
      ? { configured: true, entries: source.list().length }
      : { configured: false },
    actualModelRequestPerformed: false,
    productQualityVerified: false,
    next:
      configured.mode === "fixture"
        ? "Fixture checks mechanisms only. Use accept:real with an explicit provider and your own process credentials."
        : "Configuration resolved. Run accept:real; credentials and service compatibility are not verified by this probe.",
  };
}
