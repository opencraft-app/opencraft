import { createServer } from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { nativeText } from "./native-text.mjs";
const [configPath, output] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
await mkdir(output, { recursive: true });
let label = "setup",
  chain = Promise.resolve();
const record = (o) =>
  appendFile(
    output + "/calls.jsonl",
    JSON.stringify({ at: new Date().toISOString(), label, ...o }) + "\n",
  );
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 2000000) throw new Error("Body limit");
    }
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/label") {
      label = body.label;
      res.end("{}");
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    if (body.stream)
      throw new Error("Streaming not supported by comparison bridge");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const run = async () => {
      const started = performance.now(),
        id = randomUUID();
      let result, error;
      try {
        const system = (body.messages ?? [])
          .filter((m) => ["system", "developer"].includes(m.role))
          .map((m) => m.content)
          .join("\n\n");
        const tools = body.tools ?? [];
        const instruction =
          system +
          (tools.length
            ? "\nTransport envelope: represent your next message as JSON with content (string) and tool_calls (array of {name,arguments}, arguments is a JSON string). Use only the tool definitions supplied with the conversation. Return an empty tool_calls array for a final text response. This envelope changes transport only; follow the original task and tool instructions."
            : "");
        const schema = tools.length
          ? {
              type: "object",
              additionalProperties: false,
              required: ["content", "tool_calls"],
              properties: {
                content: { type: "string" },
                tool_calls: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "arguments"],
                    properties: {
                      name: {
                        type: "string",
                        enum: tools.map((t) => t.function.name),
                      },
                      arguments: { type: "string" },
                    },
                  },
                },
              },
            }
          : body.response_format?.type === "json_schema"
            ? body.response_format.json_schema.schema
            : undefined;
        result = await nativeText(config, {
          instruction,
          messages: tools.length
            ? {
                messages: body.messages.filter(
                  (m) => !["system", "developer"].includes(m.role),
                ),
                tools,
              }
            : body.messages.filter(
                (m) => !["system", "developer"].includes(m.role),
              ),
          schema,
          signal: controller.signal,
        });
        const decoded = tools.length
          ? JSON.parse(result.text)
          : { content: result.text, tool_calls: [] };
        const tool_calls = decoded.tool_calls.map((t) => ({
          id: "call_" + randomUUID().replaceAll("-", ""),
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        }));
        return {
          id: "chatcmpl-" + id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: config.modelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: decoded.content || null,
                ...(tool_calls.length ? { tool_calls } : {}),
              },
              finish_reason: tool_calls.length ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: result.usage?.input ?? 0,
            completion_tokens: result.usage?.output ?? 0,
            total_tokens: result.usage?.totalTokens ?? 0,
          },
        };
      } catch (e) {
        error = e;
        throw e;
      } finally {
        clearTimeout(timer);
        await record({
          id,
          model: config.modelId,
          reasoningEffort: config.reasoningEffort ?? "provider-default",
          outcome: error ? "failed" : "returned",
          error: error?.name,
          usage: result?.usage ?? error?.usage ?? null,
          elapsedMs: performance.now() - started,
          inputCharacters: raw.length,
          toolDefinitions: body.tools?.length ?? 0,
          responseFormat: body.response_format?.type ?? null,
          requestedTemperature: body.temperature ?? null,
          requestedMaxTokens:
            body.max_tokens ?? body.max_completion_tokens ?? null,
        });
      }
    };
    const task = chain.then(run);
    chain = task.catch(() => {});
    const value = await task;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Comparison bridge " + e.name, type: "bridge_error" },
      }),
    );
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      port: server.address().port,
      model: config.modelId,
      reasoningEffort: config.reasoningEffort ?? "provider-default",
    }),
  ),
);
