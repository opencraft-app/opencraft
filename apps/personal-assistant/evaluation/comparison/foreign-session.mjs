import { resolve, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { rpc } from "./processes.mjs";
import { hindsightProcess, presentHindsight } from "./hindsight-process.mjs";
import { CodexStructuredHarness } from "../../src/adapters/codex/structured-harness.mjs";
import { modelRequest } from "../../src/adapters/models/model-request.mjs";
import { READER_INSTRUCTION, readerInput, readMemoryQuestion } from "../memory-system-session.mjs";
const lab = resolve(import.meta.dirname, "../.."),
  root = resolve(lab, "..");
export function presentMemory(name, raw) {
  if (name === "hindsight") return presentHindsight(raw);
  if (name === "tdb")
    return {
      prependContext: raw?.prependContext ?? "",
      appendSystemContext: raw?.appendSystemContext ?? "",
      ...(raw?.error ? { error: raw.error, partial: raw.partial ?? false } : {}),
    };
  return {
    profile: raw?.profile ?? null,
    memories: raw?.retrieval?.memories ?? {
      schema: [],
      proactive: [],
      normal: [],
    },
  };
}
export async function foreignSession(
  input,
  { name, directory, codex, bridge, embedding, backgroundModel, signal, onRecord = () => {} },
) {
  await mkdir(directory, { recursive: true });
  const worker =
    name === "hindsight"
      ? hindsightProcess(directory)
      : name === "hy"
        ? rpc(join(root, ".benchmark-tools/hy-env/bin/python"), [join(import.meta.dirname, "hy-worker.py")], {
            cwd: lab,
            log: join(directory, "upstream.log"),
            env: { HOME: join(directory, "home") },
          })
        : rpc(
            "/opt/opencraft/bin/node",
            [
              "--import",
              join(root, "tencentdb-agent-memory/MemoryCore/node_modules/tsx/dist/loader.mjs"),
              join(import.meta.dirname, "tdb-worker.mjs"),
            ],
            {
              cwd: lab,
              log: join(directory, "upstream.log"),
              env: { HOME: join(directory, "home") },
            },
          );
  const transport = new CodexStructuredHarness(codex),
    calls = [],
    results = [],
    batches = [],
    checkpoints = [];
  const options = {
    transport,
    recordUsage: (c) => {
      calls.push(c);
      onRecord({ type: "usage", call: c });
    },
  };
  let cursor = 0,
    preparationMs = 0;
  const abortWorker = () => worker.child.kill("SIGTERM");
  signal.addEventListener("abort", abortWorker, { once: true });
  try {
    signal.throwIfAborted();
    await worker.call({
      op: "init",
      directory: join(directory, "memory"),
      bridge,
      embedding,
      model: backgroundModel,
    });
    for (let q = 0; q < input.queries.length; q++) {
      signal.throwIfAborted();
      const query = input.queries[q],
        startedPrep = performance.now();
      while (cursor < query.end) {
        const messages = [];
        let exchanges = 0;
        const begin = cursor;
        while (cursor < query.end) {
          const m = input.history[cursor];
          if (m.role === "user" && exchanges === 12) break;
          cursor++;
          if (m.role === "system") continue;
          if (m.role === "user") exchanges++;
          messages.push(m);
        }
        if (!messages.length) continue;
        const start = performance.now();
        const response = await worker.call({
          op: "add",
          messages,
          timestamp: new Date(Date.parse("2026-11-09T00:00:00Z") + begin * 100).toISOString(),
        });
        batches.push({
          begin,
          end: cursor,
          elapsedMs: performance.now() - start,
          response,
        });
        onRecord({ type: "batch", begin, end: cursor });
      }
      if (name === "tdb") await worker.call({ op: "drain" });
      preparationMs += performance.now() - startedPrep;
      const snapshot = await worker.call({ op: "snapshot" });
      await writeFile(join(directory, `checkpoint-${q}.json`), JSON.stringify(snapshot, null, 2));
      checkpoints.push({ query: q, end: query.end, preparationMs });
      const started = performance.now();
      let row;
      const trace = [];
      try {
        const recalled = await worker.call({
          op: "search",
          query: query.question,
        });
        const seed = {
          memoryContext: {
            mode:
              name === "hy"
                ? "upstream-pro-hybrid"
                : name === "hindsight"
                  ? "upstream-retain-recall"
                  : "upstream-auto-recall",
            evidence: presentMemory(name, recalled),
          },
          memoryRecall: [],
        };
        const value = readerInput(input.history.slice(0, query.end), query, "memory", seed);
        value.availableQueries = ["memory.search", ...(name === "tdb" ? ["memory.file.read"] : [])];
        value.queryContracts = {
          "memory.search": {
            description:
              "Search this isolated memory store for relevant stored facts using its native hybrid retrieval. query is natural-language text; results are bounded to 12. No raw conversation history is available.",
            parameters: { query: "1..200 characters" },
          },
          ...(name === "tdb"
            ? {
                "memory.file.read": {
                  description:
                    "Read a scene document whose scene_blocks/ path appears in memory context. Raw conversation files are unavailable.",
                  parameters: {
                    path: "returned scene_blocks/ path",
                    offset: "0..65536",
                    limit: "1..2000",
                  },
                },
              }
            : {}),
        };
        if (Buffer.byteLength(JSON.stringify(value)) > 128000) throw new Error("Initial context budget exceeded");
        const session = {
          trace,
          execute: async (p) => {
            if (trace.length >= 6) throw new Error("Query budget exceeded");
            const params = p.params ?? {};
            let result;
            if (p.name === "memory.search") {
              if (typeof params.query !== "string" || params.query.length > 200) throw new Error("Query text bound");
              result = await worker.call({ op: "search", query: params.query });
            } else if (name === "tdb" && p.name === "memory.file.read")
              result = await worker.call({
                op: "file",
                path: params.path,
                offset: params.offset ?? 0,
              });
            else throw new Error("Unavailable query");
            const observation = {
              name: p.name,
              params,
              result: p.name === "memory.search" ? presentMemory(name, result) : result,
            };
            if (Buffer.byteLength(JSON.stringify(observation)) > 12000) throw new Error("Query result budget exceeded");
            if (trace.reduce((n, t) => n + t.bytes, 0) + Buffer.byteLength(JSON.stringify(observation)) > 48000)
              throw new Error("Total query result budget exceeded");
            trace.push({
              name: p.name,
              params,
              bytes: Buffer.byteLength(JSON.stringify(observation)),
            });
            return observation;
          },
        };
        const result = await readMemoryQuestion(value, {
          signal,
          session,
          decide: async (v, s) => {
            const a = await modelRequest(
              { configured: { mode: "model" } },
              "reception",
              READER_INSTRUCTION,
              v,
              s,
              options,
            );
            return JSON.parse(
              a.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join(""),
            );
          },
        });
        row = {
          query: q,
          arm: "memory",
          status: "completed",
          ...result,
          initialContextBytes: Buffer.byteLength(JSON.stringify(value)),
          recall: recalled,
        };
      } catch (e) {
        row = {
          query: q,
          arm: "memory",
          status: "failed",
          error: e.code ?? e.name,
          message: e.message.slice(0, 300),
          hypothesis: "",
          queries: trace,
        };
      }
      row.elapsedMs = performance.now() - started;
      results.push(row);
      onRecord({ type: "answer", ...row });
      signal.throwIfAborted();
    }
    return {
      results,
      batches,
      calls,
      checkpoints,
      preparation: { elapsedMs: preparationMs, messages: cursor },
      finalSnapshot: await worker.call({ op: "snapshot" }),
    };
  } finally {
    signal.removeEventListener("abort", abortWorker);
    try {
      if (worker.child.exitCode === null && !signal.aborted) await worker.call({ op: "close" }, 10000);
    } catch {}
    await worker.close();
    await transport.close();
  }
}
