import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  SHARED_INTERACTIONS_CHANGED,
  SHARED_INTERACTIONS_RESPOND,
  type SharedInteraction,
} from "@opencraft/appserver-protocol";
import type { connectCodex } from "../../tests/cloudflare/codex-apphost-client.ts";

type Event = Awaited<ReturnType<typeof connectCodex>>["event"];
type Call = (method: string, params?: object) => Promise<any>;
const marker = () => randomBytes(8).toString("hex");

export async function proveNativeTools(options: {
  call: Call;
  event: Event;
  assignment: object;
  cwd: string;
  model: string;
  checks: string[];
  selected: readonly string[];
}) {
  const { call, event, assignment, cwd, model, checks, selected } = options;
  const errors: string[] = [];
  type Turn = {
    threadId: string;
    turnId: string;
    completed: Promise<any>;
    find: (method: string, select?: (params: any) => boolean) => Promise<any>;
  };
  async function scenario(
    label: string,
    tools: readonly string[],
    prompt: string,
    verify: (turn: Turn) => Promise<void>,
    threadId?: string,
  ) {
    if (selected.length && !tools.some((tool) => selected.includes(tool))) return;
    let id: string | undefined = threadId;
    let turnId: string | undefined;
    let completed: Promise<any> | undefined;
    try {
      id ??= (await call("thread/start", { ...assignment, model })).thread.id;
      assert.ok(id);
      console.log("OC_NATIVE_SCENARIO_START " + label);
      const { turn } = await call("turn/start", {
        threadId: id,
        clientUserMessageId: "native-" + marker(),
        input: [{ type: "text", text: "OC_NATIVE_PROOF " + tools.join(",") + "\n" + prompt }],
      });
      turnId = turn.id;
      completed = event("turn/completed", (params) => params.threadId === id && params.turn.id === turnId).then(
        (receipt) => {
          assert.equal(receipt.params.turn.status, "completed", receipt.params.turn.error?.message);
          return receipt;
        },
      );
      // A scenario may advance through a user interaction while completion waits in parallel.
      void completed.catch(() => {});
      const find = (method: string, select: (params: any) => boolean = () => true) =>
        event(method, (params) => params.threadId === id && params.turnId === turnId && select(params), 250);
      await verify({ threadId: id, turnId: turn.id, completed, find });
      await completed;
      checks.push(label);
      console.log("OC_NATIVE_SCENARIO_PASS " + label);
    } catch (error) {
      errors.push(label + ": " + String(error).slice(0, 260));
      console.log("OC_NATIVE_SCENARIO_FAIL " + errors.at(-1));
      if (turnId) await call("turn/interrupt", { threadId: id, turnId }).catch(() => {});
      await completed?.catch(() => {});
    }
  }
  async function answer(
    turn: Turn,
    method: string,
    result: (interaction: SharedInteraction) => Record<string, unknown>,
    optional = false,
  ) {
    const snapshot = await Promise.race([
      event(
        SHARED_INTERACTIONS_CHANGED,
        (params) =>
          params.threadId === turn.threadId &&
          params.requests.some(
            (entry: SharedInteraction) =>
              entry.method === method && entry.params.turnId === turn.turnId && entry.state === "pending",
          ),
      ),
      turn.completed.then(() => null),
    ]);
    if (!snapshot) {
      if (optional) return;
      throw Error("Turn completed before the native interaction");
    }
    const request = snapshot.params.requests.find(
      (item: SharedInteraction) =>
        item.method === method && item.params.turnId === turn.turnId && item.state === "pending",
    );
    assert.ok(snapshot.params.canRespond && request);
    const reply = await call(SHARED_INTERACTIONS_RESPOND, {
      threadId: turn.threadId,
      interactionId: request.id,
      submissionId: "native-" + marker(),
      result: result(request),
    });
    assert.ok(reply.disposition === "submitted" || reply.disposition === "resolved");
  }
  async function replyIncludes(turn: Turn, expected: string) {
    await turn.completed;
    const result = await call("thread/read", { threadId: turn.threadId, includeTurns: true });
    const found = result.thread.turns.find((item) => item.id === turn.turnId);
    assert.ok(
      found?.items.some((item) => item.type === "agentMessage" && item.text.includes(expected)),
      "Native history did not contain the expected result",
    );
  }

  const plan = "Verify the transport plan";
  await scenario(
    "update_plan: native plan notification",
    ["update_plan"],
    `Use the native update_plan tool to record three steps for this transport audit: "${plan}" in_progress; "Check the native input receipt" pending; "Read the completed history" pending. The actual tool call is the deliverable. Then reply Ready.`,
    async (turn) => {
      await turn.completed;
      const result = await turn.find("turn/plan/updated");
      assert.ok(result.params.plan.some((step) => step.step === plan && step.status === "inProgress"));
    },
  );

  const file = "native-patch-proof.txt";
  const contents = "patch-" + marker();
  await scenario(
    "apply_patch: native freeform call, native approval policy and file readback",
    ["apply_patch"],
    `Use the native apply_patch tool directly to create a file. Pass exactly one argument named input. Its value must be a string containing the raw patch below, with no Markdown fences:\n*** Begin Patch\n*** Add File: ${file}\n+${contents}\n*** End Patch\nAfter the tool succeeds reply Ready.`,
    async (turn) => {
      await answer(
        turn,
        "item/fileChange/requestApproval",
        (request) => {
          assert.equal(request.params.threadId, turn.threadId);
          return { decision: "accept" };
        },
        true,
      );
      await turn.completed;
      const completed = await turn.find("item/completed", (params) => params.item.type === "fileChange");
      assert.equal(completed.params.item.status, "completed");
      assert.ok(completed.params.item.changes.some((change) => change.path.endsWith(file)));
      const read = await call("fs/readFile", { workspaceThreadId: turn.threadId, path: cwd + "/" + file });
      assert.equal(Buffer.from(read.dataBase64, "base64").toString("utf8"), contents + "\n");
    },
  );

  const pty = "stdin-" + marker();
  const command = `printf 'READY_FOR_INPUT\\n'; read -r input; printf 'RECEIVED:%s\\n' "$input"`;
  await scenario(
    "write_stdin: native process session receives input and returns its output",
    ["exec_command", "write_stdin"],
    `First call exec_command with this exact shell command, tty true and yield_time_ms 1000:\n${command}\nIt will return a running session ID. Then call the native write_stdin tool on that session with chars equal to ${pty} plus a newline. Report the actual received output. Do not put the input into the command.`,
    async (turn) => {
      await turn.completed;
      const result = await turn.find(
        "item/completed",
        (params) =>
          params.item.type === "commandExecution" && params.item.aggregatedOutput?.includes("RECEIVED:" + pty),
      );
      assert.equal(result.params.item.exitCode, 0);
    },
  );

  await scenario(
    "request_user_input: native interaction response returns to the model",
    ["request_user_input"],
    'Call request_user_input with {"questions":[{"id":"proof_choice","header":"Label","question":"Which label should I use?",' +
      '"options":[{"label":"Oak (Recommended)","description":"Use the Oak label"},{"label":"Cedar","description":"Use the Cedar label"}]}]}. ' +
      "After the native result, reply with the selected label.",
    async (turn) => {
      await answer(turn, "item/tool/requestUserInput", (request) => {
        const question = (request.params.questions as { id: string; options?: { label: string }[] }[])[0]!;
        assert.ok(question.options?.some((option) => option.label === "Cedar"));
        return { answers: { [question.id]: { answers: ["Cedar"] } } };
      });
      await replyIncludes(turn, "Cedar");
    },
  );

  if (!selected.length || selected.includes("view_image")) {
    const image = "view-proof.png";
    const { thread } = await call("thread/start", { ...assignment, model });
    await call("fs/writeFile", {
      workspaceThreadId: thread.id,
      path: cwd + "/" + image,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1QAAAABJRU5ErkJggg==",
    });
    await scenario(
      "view_image: native invocation with text-only model result handling",
      ["view_image"],
      `Call view_image on the absolute path ${cwd}/${image}. Then report exactly what the tool returns. Report the limitation if the backend cannot process the image.`,
      async (turn) => {
        await turn.completed;
      },
      thread.id,
    );
  }

  await scenario(
    "list_mcp_resources: native resource directory result",
    ["list_mcp_resources"],
    "Call list_mcp_resources with the empty JSON object {} to enumerate the native MCP resources. An empty directory is a valid result. Report the outcome.",
    async (turn) => {
      await turn.completed;
    },
  );
  await scenario(
    "list_mcp_resource_templates: native template directory result",
    ["list_mcp_resource_templates"],
    "Call list_mcp_resource_templates with the empty JSON object {} to enumerate the native MCP resource templates. Even an empty result is valid.",
    async (turn) => {
      await turn.completed;
    },
  );
  await scenario(
    "read_mcp_resource: native missing-resource response",
    ["read_mcp_resource"],
    'Use read_mcp_resource with {"server":"preview-proof-missing","uri":"proof://unmounted"} to test the native handling of an unmounted resource.',
    async (turn) => {
      await turn.completed;
    },
  );

  const objective = "Goal transport check " + marker();
  await scenario(
    "create_goal, get_goal and update_goal: native goal lifecycle",
    ["create_goal", "get_goal", "update_goal"],
    `I explicitly request a persistent goal on this disposable test thread. Call create_goal with exact objective "${objective}". Then use get_goal to verify that goal. Then call update_goal to complete it. Report the returned objective.`,
    (turn) => replyIncludes(turn, objective),
  );

  const agent = "agent-" + marker();
  await scenario(
    "spawn_agent, wait_agent, close_agent, resume_agent and send_input: native agent lifecycle",
    ["spawn_agent", "wait_agent", "close_agent", "resume_agent", "send_input", "wait_agent", "close_agent"],
    `I explicitly request one subagent for this disposable test. Use native tools in this order. (1) spawn_agent with message "Reply only with READY." and fork_context false. (2) wait_agent with targets containing that returned id and timeout_ms 30000. (3) close_agent for that id. (4) resume_agent for the same id. (5) send_input to the same id using message "Reply with exactly ${agent} and no other text." (6) wait_agent with targets containing this same id and timeout_ms 30000. (7) close_agent. Report the subagent's reply. Use the returned ids instead of making them up.`,
    (turn) => replyIncludes(turn, agent),
  );

  assert.equal(errors.length, 0, errors.join("\n"));
}
