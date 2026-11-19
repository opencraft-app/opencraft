import { evaluateAssistant } from "./assistant-session.mjs";
let active = false;
process.on("message", async (message) => {
  if (active) return;
  active = true;
  const { input, directory, mode, model, apiKey, timeoutMs, harnesses } = message;
  const variable = {
    deepseek: "DEEPSEEK_API_KEY",
    "openai-compatible": "OPENCRAFT_EVAL_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  }[model?.provider];
  if (variable && apiKey) process.env[variable] = apiKey;
  try {
    const result = await evaluateAssistant(input, {
      directory,
      mode,
      model,
      harnesses,
      signal: AbortSignal.timeout(timeoutMs),
    });
    process.send({ ok: true, result }, () => process.disconnect());
  } catch (error) {
    const text = String(error?.message ?? error)
      .split(apiKey || "\0")
      .join("[redacted]")
      .slice(0, 1000);
    process.send({ ok: false, error: text }, () => process.disconnect());
  }
});
