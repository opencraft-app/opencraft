import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeText } from "./native-text.mjs";
const root = resolve(import.meta.dirname, "../../../tencentdb-agent-memory/MemoryCore");
const load = (p) => import(pathToFileURL(join(root, "src", p)).href);
const originalLog = console.log;
console.log = (...args) => console.error(...args);
const logger = {
  info: (m) => console.error(m),
  warn: (m) => console.error(m),
  error: (m) => console.error(m),
};
let opts;
let store;
let embedding;
let cfg;
let l1;
let l2;
let l3;
const _cursor = 0;
const scopes = new Set();
async function init(r) {
  opts = r;
  await mkdir(r.directory, { recursive: true });
  const { parseConfig } = await load("config.ts");
  cfg = parseConfig({
    llm: {
      enabled: true,
      baseUrl: r.bridge + "/v1",
      apiKey: "local-comparison",
      model: r.model,
      stream: false,
      timeoutMs: 120000,
    },
    embedding: {
      enabled: true,
      provider: "openai_compatible",
      baseUrl: r.embedding + "/v1",
      apiKey: "local-comparison",
      model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
      dimensions: 384,
    },
    recall: {
      strategy: "hybrid",
      maxResults: 12,
      maxChars: 24000,
      timeoutMs: 10000,
    },
  });
  const factory = await load("utils/pipeline-factory.ts");
  factory.initDataDirectories(r.directory);
  ({ vectorStore: store, embeddingService: embedding } = await factory.initStores(cfg, r.directory, logger));
  if (!store?.isFtsAvailable()) throw new Error("TDB FTS5 unavailable");
  const { StandaloneLLMRunnerFactory } = await load("adapters/standalone/llm-runner.ts");
  const rf = new StandaloneLLMRunnerFactory({ config: cfg.llm, logger });
  const { createSandboxedTools } = await load("adapters/standalone/llm-runner.eval-tools.ts");
  const nativeConfig = JSON.parse(
    await readFile(resolve(root, "../../.private/tokenhub-hy4-nothink-codex.json"), "utf8"),
  );
  const nativeRunner = {
    run: async (params) => {
      const localTools = createSandboxedTools(params.workspaceDir, logger);
      const definitions = Object.entries(localTools).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema.jsonSchema,
      }));
      const started = performance.now();
      let result, error;
      try {
        result = await nativeText(nativeConfig, {
          instruction: params.systemPrompt ?? "",
          messages: [{ role: "user", content: params.prompt }],
          signal: AbortSignal.timeout(Math.min(params.timeoutMs ?? 120000, 180000)),
          tools: definitions,
          execute: async (name, args) => {
            if (!Object.hasOwn(localTools, name)) throw new Error("Unknown file tool");
            const value = typeof args === "string" ? JSON.parse(args) : args;
            const rel = relative(resolve(params.workspaceDir), resolve(params.workspaceDir, value.path ?? ""));
            if (rel.startsWith("..") || rel.startsWith("/")) throw new Error("Tool path escapes workspace");
            return localTools[name].execute(value, {
              toolCallId: "native-comparison",
              messages: [],
            });
          },
        });
        return result.text;
      } catch (e) {
        error = e;
        throw e;
      } finally {
        await appendFile(
          join(r.directory, "native-stage-calls.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            stage: params.taskId,
            model: nativeConfig.modelId,
            reasoningEffort: nativeConfig.reasoningEffort,
            elapsedMs: performance.now() - started,
            usage: result?.usage ?? error?.usage ?? null,
            toolCalls: result?.toolCalls ?? null,
            outcome: error ? "failed" : "returned",
            error: error?.name,
          }) + "\n",
        );
      }
    },
  };
  const common = {
    pluginDataDir: r.directory,
    cfg,
    openclawConfig: {},
    vectorStore: store,
    embeddingService: embedding,
    logger,
  };
  l1 = factory.createL1Runner({
    ...common,
    llmRunner: rf.createRunner({ enableTools: false }),
  });
  l2 = factory.createL2Runner({ ...common, llmRunner: nativeRunner });
  l3 = factory.createL3Runner({ ...common, llmRunner: nativeRunner });
  await writeFile(
    join(r.directory, "resolved-config.json"),
    JSON.stringify(
      {
        ...cfg,
        llm: { ...cfg.llm, apiKey: "local-comparison" },
        embedding: { ...cfg.embedding, apiKey: "local-comparison" },
      },
      null,
      2,
    ),
  );
  return { ready: true, fts: true };
}
async function perform(r) {
  if (r.op === "init") return init(r);
  if (r.op === "add") {
    const { performAutoCapture } = await load("core/hooks/auto-capture.ts");
    const messages = r.messages.map((m, i) => ({
      ...m,
      timestamp: Date.parse(r.timestamp) + i,
    }));
    const captured = await performAutoCapture({
      messages,
      sessionKey: "conversation",
      sessionId: "conversation",
      cfg,
      pluginDataDir: opts.directory,
      logger,
      vectorStore: store,
      embeddingService: embedding,
    });
    const results = [];
    for (let i = 0; i < 100; i++) {
      const next = await l1({ sessionKey: "conversation" });
      results.push(next);
      for (const s of next.profileScopes ?? []) scopes.add(s);
      if (!next.hasMore) break;
      if (!next.processedCount) throw new Error("L1 backlog stalled");
    }
    return { captured, results };
  }
  if (r.op === "drain") {
    const result = [];
    for (const key of scopes) result.push(await l2(key));
    scopes.clear();
    await l3();
    return { layers: result };
  }
  if (r.op === "search") {
    const { performAutoRecall } = await load("core/hooks/auto-recall.ts");
    return await performAutoRecall({
      userText: r.query,
      actorId: "subject",
      sessionKey: "conversation",
      cfg,
      pluginDataDir: opts.directory,
      logger,
      vectorStore: store,
      embeddingService: embedding,
    });
  }
  if (r.op === "file") {
    const file = resolve(opts.directory, r.path);
    const rel = relative(opts.directory, file);
    if (!rel.startsWith("scene_blocks/") || rel.includes("..")) throw new Error("Only scene documents are readable");
    const content = await readFile(file, "utf8");
    const offset = r.offset ?? 0;
    return {
      content: content.slice(offset, offset + 2000),
      nextOffset: offset + 2000 < content.length ? offset + 2000 : null,
    };
  }
  if (r.op === "snapshot")
    return {
      l1: await store.countL1(),
      records: await store.queryL1Records({ limit: 10000 }),
    };
  if (r.op === "close") {
    await embedding?.close?.();
    store?.close();
    return { closed: true };
  }
  throw new Error("Unknown op");
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let r;
  try {
    r = JSON.parse(line);
    const result = await perform(r);
    originalLog(JSON.stringify({ id: r.id, ok: true, result }));
    if (r.op === "close") break;
  } catch (e) {
    console.error(e.stack);
    originalLog(
      JSON.stringify({
        id: r?.id,
        ok: false,
        error: e.name,
        message: e.message.slice(0, 300),
      }),
    );
  }
}
