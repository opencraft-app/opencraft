import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ConnectedAgentHistory } from "../../apps/local-agent-host/src/connected-agent-history.js";

test("IDE history restores native display phrases, preserving literal user text and omitting generated helpers", async t => {
  const home = await mkdtemp(join(tmpdir(), "codebuddy-ide-history-"));
  const id = "11111111-2222-4333-8444-555555555555", cwd = "/workspace", userId = "account-a";
  const source = join(home, userId, "ide", userId, "history", createHash("md5").update(cwd).digest("hex"));
  const conversation = join(source, id), directory = join(conversation, "messages");
  await mkdir(directory, { recursive: true });
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  await json(join(source, "index.json"), { conversations: [{ id, name: "Native test" }] });
  const envelope = "<user_info>\nworkspace details\n</user_info>\n<project_context>private project instructions</project_context>\n<user_query>\nHello\n</user_query>";
  const rows = [
    { id: "user", role: "user", message: JSON.stringify({ role: "user", content: [{ type: "text", text: envelope }] }),
      extra: JSON.stringify({ inputPhrase: [{ type: "normal", content: "Hello", expandContent: "different execution data" }] }) },
    { id: "assistant", role: "assistant", message: { content: [{ type: "text", text: "Native reply" }] } },
    { id: "helper", role: "user", message: { content: "generated summary" }, extra: JSON.stringify({ isHelperMessage: true }) },
    { id: "literal", role: "user", message: { content: "Literal <user_query>example</user_query>" }, extra: { inputPhrase: [{ type: "normal", content: "do not replace literal text" }] } },
  ];
  await json(join(conversation, "index.json"), { messages: rows.map(({ id }) => ({ id })), requests: [] });
  for (const row of rows) await json(join(directory, `${row.id}.json`), row);
  const history = new ConnectedAgentHistory("codebuddy-ide", home, undefined, [], async () => ({ userId, cwd, currentSessionId: id }));
  t.after(async () => { await history.close(); await rm(home, { recursive: true, force: true }); });
  const turns = await history.snapshot(id, { cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].items[0].content[0].text, "Hello");
  assert.equal(turns[0].items[1].text, "Native reply");
  assert.equal(turns[1].items[0].content[0].text, "Literal <user_query>example</user_query>");
  assert.doesNotMatch(JSON.stringify(turns), /private project instructions|generated summary|different execution data/);
});
