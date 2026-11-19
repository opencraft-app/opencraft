import { evaluateMemorySystem } from "./memory-system-session.mjs";
let active = false;
process.on("message", async ({ input, directory, codex, backgroundCodex, timeoutMs, referenceDirectory }) => {
  if (active) return;
  active = true;
  try {
    const result = await evaluateMemorySystem(input, {
      directory,
      codex,
      backgroundCodex,
      signal: AbortSignal.timeout(timeoutMs),
      referenceDirectory,
      onRecord: (record) => process.send({ kind: "progress", record }),
    });
    process.send({ kind: "result", ok: true, result }, () => process.disconnect());
  } catch (error) {
    process.send(
      {
        kind: "result",
        ok: false,
        error: error.code ?? error.name ?? "Error",
      },
      () => process.disconnect(),
    );
  }
});
