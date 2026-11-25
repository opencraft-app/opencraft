import { createHash } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const model = "@cf/openai/gpt-oss-20b";
const alias = "gpt-oss-20b";
const encoder = new TextEncoder();

const nativeKey = ({ name, namespace }) => JSON.stringify([namespace ?? null, name]);
const callable = (tool) => tool.type === "function" || tool.type === "custom";

function argObject(text) {
  const args = JSON.parse(text);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Expected tool arguments as a JSON object");
  return args;
}

function toolCatalog(body) {
  const declarations = (body.tools ?? [])
    .flatMap((tool) =>
      tool.type === "namespace" ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name })) : [tool],
    )
    .filter(callable);
  const identities = new Map();
  for (const tool of declarations) {
    const key = nativeKey(tool);
    if (identities.has(key)) throw Error("Duplicate native tool identity");
    identities.set(key, tool);
  }
  for (const item of body.input ?? []) {
    if ((item.type === "function_call" || item.type === "custom_tool_call") && !identities.has(nativeKey(item)))
      identities.set(nativeKey(item), item);
  }
  const counts = new Map();
  for (const { name } of identities.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const aliases = new Map();
  const reserved = new Set([...counts.keys()].filter((name) => /^[a-zA-Z0-9_-]{1,64}$/u.test(name)));
  for (const [key, identity] of identities) {
    const { name } = identity;
    let alias = name;
    if (counts.get(name) !== 1 || !reserved.has(name)) {
      const hash = createHash("sha256").update(key).digest("hex");
      alias = name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 35) + "_" + hash.slice(0, 24);
      if (reserved.has(alias)) throw Error("Tool alias collision");
      reserved.add(alias);
    }
    aliases.set(key, alias);
  }
  return { declarations, aliases };
}

function projectTool(tool, name) {
  if (tool.type === "function") {
    return { type: "function", function: { name, description: tool.description, parameters: tool.parameters } };
  }
  const syntax =
    tool.format?.type === "grammar" ? "\nInput grammar (" + tool.format.syntax + "):\n" + tool.format.definition : "";
  return {
    type: "function",
    function: {
      name,
      description:
        "Call with a JSON object containing the required input string. " +
        "The native description applies to that string, whose contents are sent unchanged. " +
        (tool.description ?? ""),
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Pass the exact raw tool input as this string." + syntax },
        },
        required: ["input"],
        additionalProperties: false,
      },
    },
  };
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content
    .map((part) => {
      if (part.type === "input_text" || part.type === "output_text") return part.text;
      if (part.type === "input_image" || part.type === "output_image")
        return "[Image returned by the native tool. GPT-OSS 20B can only read text.]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function chatInput(body, onResult) {
  const { declarations, aliases } = toolCatalog(body);
  const catalog = new Map(declarations.map((tool) => [aliases.get(nativeKey(tool)), tool]));
  const messages = [];
  const pending = new Map();
  const groups = new Map();
  let latestResult;
  if (typeof body.instructions === "string") messages.push({ role: "system", content: body.instructions });
  for (const item of body.input ?? []) {
    if (item.type === "message") {
      const content = textContent(item.content);
      if (content) messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = aliases.get(nativeKey(item));
      const args = item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments;
      const previous = messages.at(-1);
      const call = { id: item.call_id, type: "function", function: { name, arguments: args } };
      let group = groups.get(previous);
      if (!group || group.outputs.length) {
        // Workers AI requires a string on a tool-only assistant message.
        const assistant = { role: "assistant", content: "", tool_calls: [] };
        group = { assistant, outputs: [] };
        groups.set(assistant, group);
        messages.push(assistant);
      }
      group.assistant.tool_calls.push(call);
      pending.set(item.call_id, { item, group });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const entry = pending.get(item.call_id);
      if (entry && item.type === entry.item.type + "_output") {
        entry.group.outputs.push({
          message: { role: "tool", tool_call_id: item.call_id, content: textContent(item.output) },
          proof: {
            name: entry.item.name,
            namespace: entry.item.namespace,
            contentTypes: Array.isArray(item.output) ? item.output.map((part) => part.type) : [typeof item.output],
          },
        });
        pending.delete(item.call_id);
        latestResult = entry.group;
      }
    }
  }
  const ordered = messages.flatMap((message) => {
    const group = groups.get(message);
    if (!group) return [message];
    const completed = new Set(group.outputs.map((entry) => entry.message.tool_call_id));
    const calls = message.tool_calls.filter((call) => completed.has(call.id));
    return calls.length ? [{ ...message, tool_calls: calls }, ...group.outputs.map((entry) => entry.message)] : [];
  });
  for (const output of latestResult?.outputs ?? []) onResult?.(output.proof);
  let choice = body.tool_choice ?? "auto";
  if (typeof choice === "object" && choice !== null) {
    if (choice.type === "allowed_tools") {
      const allowed = new Set(choice.tools.filter(callable).map((tool) => nativeKey(tool)));
      for (const [alias, tool] of catalog) if (!allowed.has(nativeKey(tool))) catalog.delete(alias);
      choice = choice.mode;
    } else {
      const name = aliases.get(nativeKey(choice));
      if (!callable(choice) || !catalog.has(name)) throw Error("Requested tool cannot be represented by Workers AI");
      choice = { type: "function", function: { name } };
    }
  }
  if (choice === "required" && !catalog.size) throw Error("No compatible tool for the required tool choice");
  return {
    catalog,
    input: {
      messages: ordered,
      stream: true,
      max_tokens: 2048,
      reasoning_effort: "low",
      ...(catalog.size
        ? { tools: Array.from(catalog, ([name, tool]) => projectTool(tool, name)), tool_choice: choice }
        : {}),
    },
  };
}

async function* chatChunks(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      pending += read.value;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).trimEnd();
        pending = pending.slice(end + 1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        yield JSON.parse(payload);
      }
      if (pending.length > 1024 * 1024) throw Error("Workers AI SSE frame exceeds limit");
    }
    if (pending.trim()) throw Error("Incomplete Workers AI SSE frame");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function projectStream(upstream, output, catalog, onTool) {
  const outputItems = [];
  const calls = new Map();
  let messageIndex;
  let finished = false;
  let usage = {};
  let sequence = 0;
  const response = {
    id: "resp_" + crypto.randomUUID(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: alias,
  };
  const send = (type, fields) => {
    const event = { type, sequence_number: sequence++, ...fields };
    return output.write(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
  };
  const add = async (item) => {
    const index = outputItems.push(item) - 1;
    await send("response.output_item.added", { output_index: index, item });
    return index;
  };
  await send("response.created", { response: { ...response, status: "in_progress", output: [] } });
  for await (const chunk of chatChunks(upstream)) {
    if (chunk.error) throw Error("Workers AI rejected its stream");
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls") finished = true;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (messageIndex === undefined) {
        messageIndex = await add({
          id: "msg_" + crypto.randomUUID(),
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        });
        const item = outputItems[messageIndex];
        const part = { type: "output_text", text: "", annotations: [] };
        item.content.push(part);
        await send("response.content_part.added", {
          item_id: item.id,
          output_index: messageIndex,
          content_index: 0,
          part,
        });
      }
      const item = outputItems[messageIndex];
      item.content[0].text += delta.content;
      await send("response.output_text.delta", {
        item_id: item.id,
        output_index: messageIndex,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const call of delta.tool_calls ?? []) {
      let state = calls.get(call.index);
      if (state === undefined) {
        const tool = catalog.get(call.function?.name);
        if (!Number.isInteger(call.index) || typeof call.id !== "string" || !tool)
          throw Error(
            "Unsupported Workers AI tool call (name: " +
              (/^[a-zA-Z0-9_.-]{1,64}$/u.test(call.function?.name) ? call.function.name : "absent") +
              ", id: " +
              (typeof call.id === "string" ? "present" : "absent") +
              ", index: " +
              String(call.index) +
              ")",
          );
        const custom = tool.type === "custom";
        const index = await add({
          id: "fc_" + crypto.randomUUID(),
          call_id: call.id,
          type: custom ? "custom_tool_call" : "function_call",
          name: tool.name,
          ...(custom ? { input: "" } : { arguments: "" }),
          status: "in_progress",
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
        });
        state = { index, encoded: "" };
        calls.set(call.index, state);
      }
      const item = outputItems[state.index];
      if (typeof call.function?.arguments === "string" && call.function.arguments) {
        if (item.type === "custom_tool_call") state.encoded += call.function.arguments;
        else {
          item.arguments += call.function.arguments;
          await send("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: state.index,
            delta: call.function.arguments,
          });
        }
      }
    }
  }
  if (!finished || !outputItems.length) throw Error("Workers AI did not finish its response");
  for (const { index, encoded } of calls.values()) {
    const item = outputItems[index];
    if (item.type !== "custom_tool_call") continue;
    const args = argObject(encoded);
    const values = Object.values(args);
    // Models can rename the wrapper field. A single string still identifies
    // the freeform payload without changing a byte of the native input.
    const input =
      typeof args.input === "string"
        ? args.input
        : values.length === 1 && typeof values[0] === "string"
          ? values[0]
          : null;
    if (input === null) {
      const keys = Object.keys(args)
        .filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u.test(key))
        .slice(0, 6);
      throw Error("Workers AI custom tool omitted its required input string (fields: " + keys.join(", ") + ")");
    }
    item.input = input;
  }
  for (const [index, item] of outputItems.entries()) {
    item.status = "completed";
    const position = { item_id: item.id, output_index: index };
    if (item.type === "function_call") {
      argObject(item.arguments);
      await send("response.function_call_arguments.done", { ...position, arguments: item.arguments, name: item.name });
    } else if (item.type === "custom_tool_call") {
      await send("response.custom_tool_call_input.delta", { ...position, delta: item.input });
      await send("response.custom_tool_call_input.done", { ...position, input: item.input });
    } else {
      const part = item.content[0];
      await send("response.output_text.done", { ...position, content_index: 0, text: part.text });
      await send("response.content_part.done", { ...position, content_index: 0, part });
    }
    await send("response.output_item.done", { output_index: index, item });
    if (item.type !== "message") onTool?.({ type: item.type, name: item.name, namespace: item.namespace });
  }
  await send("response.completed", {
    response: {
      ...response,
      status: "completed",
      output: outputItems,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
    },
  });
}

/** Private real-model provider for the cloud rehearsal. Codex owns tool execution. */
export default {
  async fetch(request, env, ctx) {
    if (
      !env.REHEARSAL_PROVIDER_PROOF ||
      request.headers.get("authorization") !== "Bearer " + env.REHEARSAL_PROVIDER_PROOF
    )
      return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/v1/models")
      return Response.json({ object: "list", data: [{ id: alias, object: "model", owned_by: "workers-ai" }] });
    if (request.method !== "POST" || path !== "/v1/responses") return new Response(null, { status: 404 });
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding");
      const zstd = encoding === "zstd" || bytes.slice(0, 4).join(",") === "40,181,47,253";
      const decoded = zstd ? zstdDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes;
      const body = JSON.parse(new TextDecoder().decode(decoded));
      if (body.model !== alias || body.stream !== true || body.previous_response_id)
        return Response.json({ error: { message: "Unsupported Workers AI rehearsal request" } }, { status: 422 });
      if (env.REHEARSAL_TOOL_CATALOG === "1")
        console.log(
          "OC_NATIVE_TOOL_CATALOG " +
            JSON.stringify(
              (body.tools ?? []).map((tool) => ({
                type: tool.type,
                name: tool.name,
                ...(Array.isArray(tool.tools)
                  ? { tools: tool.tools.map((item) => ({ type: item.type, name: item.name })) }
                  : {}),
              })),
            ),
        );
      const onResult =
        env.REHEARSAL_TOOL_CATALOG === "1"
          ? (tool) => console.log("OC_NATIVE_TOOL_RESULT " + JSON.stringify(tool))
          : undefined;
      const { input, catalog } = chatInput(body, onResult);
      const inference = await env.AI.run(model, input);
      if (!(inference instanceof ReadableStream)) throw Error("Workers AI did not return a live stream");
      const stream = new TransformStream();
      const writer = stream.writable.getWriter();
      const onTool =
        env.REHEARSAL_TOOL_CATALOG === "1"
          ? (tool) => console.log("OC_NATIVE_TOOL_CALL " + JSON.stringify(tool))
          : undefined;
      ctx.waitUntil(
        projectStream(inference, writer, catalog, onTool).then(
          () => writer.close(),
          async (error) => {
            console.warn("Workers AI rehearsal stream failed", String(error).slice(0, 200));
            await writer.abort().catch(() => {});
          },
        ),
      );
      return new Response(stream.readable, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    } catch (error) {
      console.warn("Workers AI rehearsal inference failed", String(error).slice(0, 450));
      return Response.json({ error: { message: "Workers AI inference unavailable" } }, { status: 502 });
    }
  },
};
