import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RunPolicy } from "../../domain/run-policy.mjs";
import { withRequestDeadline } from "../local/request-deadline.mjs";

/** Shared one-shot model transport: limits/observations only, no proposal parsing or commands. */
export async function modelRequest(
  catalog,
  kind,
  instruction,
  input,
  signal,
  {
    recordUsage = () => {},
    onUsageError = () => {},
    policy = catalog.profile?.config.runPolicy,
    maxTokens = kind === "reception" ? 1500 : 1800,
    transport,
    telemetry,
  } = {},
) {
  if (telemetry)
    return telemetry.run(
      "gen_ai.operation",
      {
        "app.model_role": kind,
        "app.harness": transport ? "codex" : "pi",
        "gen_ai.request.model":
          transport?.modelId ?? catalog.configured.model?.modelId ?? "fixture",
      },
      async (span) => {
        const result = await modelRequest(
          catalog,
          kind,
          instruction,
          input,
          signal,
          { recordUsage, onUsageError, policy, maxTokens, transport },
        );
        const usage = result.usage;
        if (Number.isFinite(usage?.input))
          span.setAttribute("gen_ai.usage.input_tokens", usage.input);
        if (Number.isFinite(usage?.output))
          span.setAttribute("gen_ai.usage.output_tokens", usage.output);
        return result;
      },
    );
  const limits = RunPolicy.resolve(policy),
    choice = transport
      ? {
          mode: "model",
          model: { provider: transport.provider, modelId: transport.modelId },
        }
      : catalog.configured;
  const id = `call:${randomUUID()}`,
    started = performance.now();
  let answer, error;
  try {
    const model = transport
      ? null
      : choice.models.getModel(choice.model.provider, choice.model.modelId);
    answer = await withRequestDeadline(
      (requestSignal) =>
        transport
          ? transport.complete({
              kind,
              instruction,
              input,
              signal: requestSignal,
              maxTokens,
            })
          : choice.models.completeSimple(
              model,
              {
                systemPrompt: instruction,
                messages: [
                  {
                    role: "user",
                    content: JSON.stringify(input),
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                signal: requestSignal,
                maxTokens,
                timeoutMs: limits.modelTimeoutMs,
                maxRetries: limits.maxRetries,
              },
            ),
      signal,
      limits.modelTimeoutMs,
    );
    if (["error", "aborted"].includes(answer.stopReason))
      throw new Error(answer.errorMessage ?? "Model request failed");
    return answer;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    try {
      recordUsage({
        id,
        kind,
        provider: choice.model.provider,
        model: choice.model.modelId,
        mode: choice.mode,
        usage:
          answer?.usage && choice.model.provider === "openai-compatible"
            ? { ...answer.usage, cost: undefined } // Unknown endpoint pricing must not become a zero-dollar estimate.
            : (answer?.usage ?? error?.usage),
        outcome: error
          ? error.code === "RUN_LIMIT_MODEL_TIMEOUT"
            ? "timeout"
            : signal?.aborted
              ? "aborted"
              : "error"
          : "returned",
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      onUsageError(error);
    }
  }
}
