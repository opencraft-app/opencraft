import type { RuntimeModelProbeParams, RuntimeModelProbeResponse } from "@opencraft/appserver-protocol";
import { modelBaseUrlError } from "@opencraft/appserver-protocol";

/** Tests only the supplied draft transport. Never reads credentials/settings or creates a conversation. */
export async function probeRuntimeModel(input: RuntimeModelProbeParams): Promise<RuntimeModelProbeResponse> {
  if (!input || typeof input.baseURL !== "string" || typeof input.model !== "string" || !input.model.trim()
    || input.model.length > 256 || !["openai-completions", "openai-responses", "anthropic-messages"].includes(input.api)
    || (input.apiKey !== undefined && (typeof input.apiKey !== "string" || /[\r\n\0]/.test(input.apiKey)))) {
    throw new Error("Invalid model probe configuration");
  }
  let base: URL;
  try { base = new URL(input.baseURL); } catch { throw new Error("Enter a valid HTTP(S) base URL"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Endpoint must be an HTTP(S) base URL without credentials, query or fragment");
  }
  const issue = modelBaseUrlError(input.baseURL, input.api); if (issue) throw new Error(issue);
  const started = Date.now();
  const signal = AbortSignal.timeout(15_000);
  const result = (ok: boolean, error?: string): RuntimeModelProbeResponse => ({ ok, model: input.model.trim(), elapsedMs: Date.now() - started, ...(error ? { error } : {}) });
  try {
    const anthropic = input.api === "anthropic-messages";
    const responses = input.api === "openai-responses";
    const response = await fetch(`${base.toString().replace(/\/+$/, "")}/${anthropic ? "v1/messages" : responses ? "responses" : "chat/completions"}`, {
      method: "POST", redirect: "error", signal,
      headers: {
        "content-type": "application/json",
        ...(anthropic ? { "anthropic-version": "2023-06-01", ...(input.apiKey?.trim() ? { "x-api-key": input.apiKey.trim() } : {}) }
          : input.apiKey?.trim() ? { authorization: `Bearer ${input.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(anthropic
        ? { model: input.model.trim(), messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 64 }
        : responses
          ? { model: input.model.trim(), input: "Reply with OK.", stream: false, max_output_tokens: 64 }
          : { model: input.model.trim(), messages: [{ role: "user", content: "Reply with OK." }], stream: false, max_tokens: 64 }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return result(false, `Endpoint returned HTTP ${response.status}. Check the model, protocol and authentication.`);
    }
    const reader = response.body?.getReader();
    if (!reader) return result(false, "Endpoint returned an empty response.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 256 * 1024) return result(false, "Probe response exceeds the size limit.");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text = anthropic
      ? Array.isArray(body.content) && body.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
      : responses
        ? body.output?.some((item: any) => item.type === "message" && item.content?.some((part: any) => part.type === "output_text" && typeof part.text === "string" && part.text.trim()))
        : body.choices?.some((item: any) => typeof item.message?.content === "string" && item.message.content.trim());
    return text ? result(true) : result(false, "Endpoint responded but did not return a text completion. Check the protocol and model.");
  } catch {
    return result(false, signal.aborted ? "Probe timed out. No automatic retry was made." : "Could not complete the probe. Check the endpoint, network and request format.");
  }
}
