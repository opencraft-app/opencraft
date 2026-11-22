// Local stand-in for the Codex model upstream, for drills that run real native
// Codex against tests/fixtures/bridge-stack-core.ts. It answers every user text
// with "echo: <text>", generated titles with "Fake title …", lists two models
// and reports a Pro plan. Loopback only; it never forwards anything.
//
// Markers in the user text steer it:
//   STACK-SLOW  the first such request is held open until POST /release
//   UI-WAIT     the answer is delayed by 8 s (time to interact mid-turn)
//
// As a program: node tests/fixtures/fake-responses-model.mjs <request-log> <port-file>
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const model = (slug, name, priority) => ({
  slug,
  display_name: name,
  description: "Local stand-in model",
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low", description: "low" }],
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  base_instructions: "You are Codex.",
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  supports_reasoning_summary_parameter: false,
  default_reasoning_summary: "none",
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: null,
  web_search_tool_type: "text",
  truncation_policy: { mode: "bytes", limit: 10000 },
  supports_image_detail_original: false,
  context_window: 128000,
  max_context_window: 128000,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: false,
  supports_experimental_context: false,
  use_responses_lite: false,
  supports_reasoning_effort_updates: false,
});

/**
 * Start the stand-in on 127.0.0.1. `requests` receives every model request's last
 * user text. Resolves with its base URL and a close function.
 */
export async function startFakeResponsesModel({ onRequest = () => {} } = {}) {
  const held = new Set();
  let slowSeen = 0;
  const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const path = request.url?.split("?")[0] ?? "";
    if (path.endsWith("/usage")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"plan_type":"pro"}');
    }
    if (path.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({ models: [model("gpt-test", "Fake GPT", 1), model("gpt-5.4-mini", "Fake mini", 2)] }),
      );
    }
    if (path === "/release") {
      for (const open of held) open.end();
      held.clear();
      return response.end("ok");
    }
    if (!path.endsWith("/responses")) {
      response.writeHead(404);
      return response.end();
    }
    const raw = Buffer.concat(chunks);
    const encoding = request.headers["content-encoding"];
    const body = JSON.parse(
      (encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw).toString(),
    );
    const texts =
      (body.input ?? [])
        .filter((item) => item.role === "user")
        .at(-1)
        ?.content?.filter((part) => part.type === "input_text")
        .map((part) => part.text) ?? [];
    const text = texts.join("\n");
    const title = JSON.stringify(body).includes("Generate a concise UI title");
    onRequest({ at: Date.now(), text, title });
    const id = `resp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    event(response, {
      type: "response.created",
      response: { id, object: "response", status: "in_progress", output: [] },
    });
    if (/STACK-SLOW/u.test(text) && slowSeen++ === 0) {
      held.add(response);
      return;
    }
    const answer = title
      ? JSON.stringify({ title: "Fake title " + text.slice(-12).replace(/\W+/gu, " ").trim() })
      : `echo: ${texts.at(-1) ?? ""}`;
    const item = {
      type: "message",
      id: `m-${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answer, annotations: [] }],
    };
    event(response, {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    await new Promise((done) => setTimeout(done, /UI-WAIT/u.test(texts.at(-1) ?? "") ? 8000 : 400));
    event(response, {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: answer,
    });
    event(response, { type: "response.output_item.done", output_index: 0, item });
    event(response, {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    response.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const open of held) open.end();
      server.closeAllConnections();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

// Only as this file itself: bundled into a drill, import.meta.url names the bundle.
const self = fileURLToPath(import.meta.url);
if (self.endsWith("fake-responses-model.mjs") && process.argv[1] && resolve(process.argv[1]) === self) {
  const [log, portFile] = process.argv.slice(2);
  const started = await startFakeResponsesModel({
    onRequest: (entry) => log && appendFileSync(log, JSON.stringify(entry) + "\n"),
  });
  if (portFile) writeFileSync(portFile, new URL(started.url).port);
  console.log(started.url);
}
