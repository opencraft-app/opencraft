// The isolated acceptance run can ask the real model for a specific call, so
// an ordinary model reply cannot silently skip a tool in the acceptance suite.
import provider from "./rehearsal-codex-workers-ai.mjs";

const marker = /^OC_NATIVE_PROOF ([a-z_,]+)\n/u;

function orderTools(input) {
  const index = input.messages.findLastIndex((message) => message.role === "user" && marker.test(message.content));
  if (index === -1) return { input };
  const source = input.messages[index];
  const [prefix, order] = marker.exec(source.content);
  const messages = input.messages.map((message, position) =>
    position === index ? { ...source, content: source.content.slice(prefix.length) } : message,
  );
  const calls = messages.slice(index + 1).flatMap((message) => message.tool_calls ?? []);
  const last = messages.slice(index + 1).findLast((message) => message.role === "tool");
  if (last?.role === "tool") {
    const name = calls.find((call) => call.id === last.tool_call_id)?.function.name;
    // The scripted prompts and resources are synthetic. Only these disposable
    // rehearsals record a bounded result sample for diagnosing native errors.
    if (name) console.log("OC_NATIVE_PROBE_OUTPUT " + JSON.stringify({ name, text: last.content.slice(0, 320) }));
  }
  const next = order.split(",")[calls.length];
  if (!next) return { input: { ...input, messages, tool_choice: "none" } };
  const tool = input.tools?.find((entry) => entry.function.name === next);
  if (!tool) throw Error("Native tool is missing from the live catalog: " + next);
  const instruction =
    "This acceptance step requires the native function " +
    next +
    ". For this step, issue the function call with the user's arguments before returning any text.";
  return {
    name: next,
    input: {
      ...input,
      messages: [{ role: "system", content: instruction }, ...messages],
      tools: [tool],
      tool_choice: "required",
    },
  };
}

async function invoke(ai, model, nativeInput) {
  const { name, input } = orderTools(nativeInput);
  const inference = await ai.run(model, input);
  if (!name || !(inference instanceof ReadableStream)) return inference;
  // Check the isolated proof used a real function call. Workers AI may choose
  // prose even when Chat Completions requests a tool. Give the model one retry.
  const [inspect, result] = inference.tee();
  const text = await new Response(inspect).text();
  const called = text.split("\n").some((line) => {
    if (!line.startsWith("data: {")) return false;
    try {
      return JSON.parse(line.slice(6)).choices?.some((choice) =>
        choice.delta?.tool_calls?.some((call) => call.function?.name === name),
      );
    } catch {
      return false;
    }
  });
  if (called) return result;
  await result.cancel();
  console.log("OC_NATIVE_PROBE_RETRY " + name);
  const last = input.messages.findLastIndex(
    (message) => message.role === "user" && !message.content.includes("<subagent_notification>"),
  );
  const messages = input.messages.map((message, index) =>
    index === last
      ? {
          ...message,
          content: message.content + "\nCall " + name + " now. In this test a text reply cannot pass.",
        }
      : message,
  );
  return ai.run(model, { ...input, messages, tool_choice: "auto", temperature: 0.1 });
}

export default {
  fetch(request, env, ctx) {
    return provider.fetch(
      request,
      {
        ...env,
        AI: { run: (model, input) => invoke(env.AI, model, input) },
      },
      ctx,
    );
  },
};
