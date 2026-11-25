// Responses fixture reached through the deployed WorkspaceHost's model egress.
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const callId = "cloud-rehearsal-hands";
const planId = "cloud-rehearsal-plan";
const patchId = "cloud-rehearsal-patch";
const summary = "I will verify the Linux workspace.";
const patch = ["*** Begin Patch", "*** Add File: cloud-hands-proof.txt", "+workspace-proof", "*** End Patch"].join(
  "\n",
);
const marker = "OC_CF_HANDS_EXEC_OK";
const command = [
  "set -eu",
  'test "$(cat cloud-hands-proof.txt)" = workspace-proof',
  `printf '${marker}\\n'`,
  "printf 'UID=%s\\n' \"$(id -u)\"",
  "printf 'NOFILE=%s\\n' \"$(ulimit -n)\"",
  "printf 'PWD=%s\\n' \"$(pwd)\"",
  "cat /proc/self/cgroup",
].join("; ");
const encoder = new TextEncoder();
const notFound = () => new Response(null, { status: 404 });

async function emit(writer, items) {
  const send = (value) => writer.write(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`));
  const response = { id: `response-${items.at(-1).id}`, object: "response", created_at: 1 };
  await send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  for (const [index, item] of items.entries()) {
    const position = { item_id: item.id, output_index: index };
    const pending = {
      function_call: { arguments: "" },
      custom_tool_call: { input: "" },
      message: { content: [] },
      reasoning: { summary: [] },
    }[item.type];
    await send({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, ...pending, status: "in_progress" },
    });
    if (item.type === "function_call") {
      await send({ type: "response.function_call_arguments.delta", ...position, delta: item.arguments });
      await send({ type: "response.function_call_arguments.done", ...position, arguments: item.arguments });
    } else if (item.type === "custom_tool_call") {
      await send({ type: "response.custom_tool_call_input.delta", ...position, delta: item.input });
      await send({ type: "response.custom_tool_call_input.done", ...position, input: item.input });
    } else if (item.type === "reasoning") {
      const part = { ...position, summary_index: 0 };
      await send({ type: "response.reasoning_summary_part.added", ...part, part: { type: "summary_text", text: "" } });
      await send({ type: "response.reasoning_summary_text.delta", ...part, delta: summary });
      await send({ type: "response.reasoning_summary_text.done", ...part, text: summary });
    } else {
      const text = item.content[0].text;
      for (const delta of text === "CLOUD_HANDS_VERIFIED" ? ["CLOUD_HANDS_", "VERIFIED"] : [text]) {
        await send({ type: "response.output_text.delta", ...position, content_index: 0, delta });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await send({ type: "response.output_text.done", ...position, content_index: 0, text });
    }
    await send({ type: "response.output_item.done", output_index: index, item });
  }
  await send({
    type: "response.completed",
    response: {
      ...response,
      status: "completed",
      output: items,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  await writer.close();
}

function functionCall(tool, id, args) {
  return { id, type: "function_call", status: "completed", ...tool, call_id: id, arguments: JSON.stringify(args) };
}

const message = (text) => ({
  id: "rehearsal-message",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

function responseItems(body) {
  const outputFor = (id) =>
    body.input?.findLast(
      (entry) =>
        (entry.type === "function_call_output" || entry.type === "custom_tool_call_output") && entry.call_id === id,
    );
  const tools = (body.tools ?? []).flatMap((tool) =>
    Array.isArray(tool.tools) ? tool.tools.map(({ name }) => ({ name, namespace: tool.name })) : [{ name: tool.name }],
  );
  const find = (name) => tools.find((tool) => tool.name === name);
  if (!outputFor(planId)) {
    const plan = find("update_plan");
    if (!plan) return [message("REHEARSAL_TOOL_MISSING update_plan")];
    return [
      { id: "rehearsal-reasoning", type: "reasoning", summary: [{ type: "summary_text", text: summary }] },
      functionCall(plan, planId, { plan: [{ step: "Verify the Linux workspace", status: "in_progress" }] }),
    ];
  }
  if (!outputFor(patchId)) {
    const file = find("apply_patch");
    if (file)
      return [{ id: patchId, type: "custom_tool_call", status: "completed", ...file, call_id: patchId, input: patch }];
    const exec = find("exec_command");
    if (!exec) return [message("REHEARSAL_TOOL_MISSING apply_patch")];
    // Codex also recognizes patches submitted through its own exec_command tool.
    return [functionCall(exec, patchId, { cmd: "apply_patch <<'PATCH'\n" + patch + "\nPATCH\n" })];
  }
  const tool = outputFor(callId);
  if (!tool) {
    const exec = find("exec_command");
    if (!exec) return [message("REHEARSAL_TOOL_MISSING exec_command")];
    return [functionCall(exec, callId, { cmd: command, yield_time_ms: 8000 })];
  }
  const output = typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output);
  const files = output?.match(/^NOFILE=(unlimited|[0-9]+)$/mu)?.[1];
  const checks = {
    exit: /Process exited with code 0/u.test(output),
    marker: output?.includes(marker),
    uid: /^UID=[1-9][0-9]*$/mu.test(output),
    files: files === "unlimited" || Number(files) >= 65536,
    cwd: /^PWD=\/[^\n]+\/cloud-project-demo$/mu.test(output),
    cgroup: /^0::\/opencraft-workspace$/mu.test(output),
  };
  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const text = failures.length ? `HANDS_FAILED ${failures.join(", ")}` : "CLOUD_HANDS_VERIFIED";
  return [message(text)];
}

export default {
  async fetch(request, env, ctx) {
    if (
      !env.REHEARSAL_PROVIDER_PROOF ||
      request.headers.get("authorization") !== `Bearer ${env.REHEARSAL_PROVIDER_PROOF}`
    )
      return notFound();
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/v1/models")
      return Response.json({ object: "list", data: [{ id: "gpt-5.4", object: "model", owned_by: "fixture" }] });
    if (request.method !== "POST" || path !== "/v1/responses") return notFound();
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding");
      const zstd = encoding === "zstd" || bytes.slice(0, 4).join(",") === "40,181,47,253";
      const raw = zstd ? zstdDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes;
      const body = JSON.parse(new TextDecoder().decode(raw));
      const items =
        env.REHEARSAL_PROVIDER_MODE === "preview"
          ? [message("云端预览已收到你的消息。当前使用的是测试模型。")]
          : responseItems(body);
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      ctx.waitUntil(emit(writer, items).catch(() => writer.abort().catch(() => undefined)));
      return new Response(stream.readable, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    } catch {
      return Response.json({ error: { message: "Invalid rehearsal Responses request" } }, { status: 422 });
    }
  },
};
