import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatDocumentCompiler,
  ChatDocumentStreamingSession,
  chatDocumentPlainText,
  type ChatDocumentNode,
} from "@opencraft/chat-document";

function flatten(nodes: readonly ChatDocumentNode[]): ChatDocumentNode[] {
  return nodes.flatMap((node) => [node,
    ...("children" in node ? flatten(node.children) : []),
    ...(node.kind === "table" ? [node.header, ...node.rows].flatMap((row) => row.flatMap(flatten)) : []),
  ]);
}

test("completed syntax is shared across mounts but dialect, edits and streaming are separate", () => {
  const compiler = new ChatDocumentCompiler();
  const source = "# Heading\n\n**bold**\nnext";
  const completed = compiler.compile(source);
  assert.equal(compiler.compile(source, { streaming: false }), completed);
  const user = compiler.compile(source, { dialect: "user-message" });
  assert.notEqual(user, completed);
  assert.deepEqual(user, new ChatDocumentCompiler().compile(source, { dialect: "user-message" }));
  assert.notEqual(compiler.compile(`${source}!`), completed);
  assert.notEqual(compiler.compile(source, { streaming: true }), completed);
  assert.equal(compiler.compile(source), completed);
});

test("completion cannot reuse the repaired syntax of an unfinished stream", () => {
  const compiler = new ChatDocumentCompiler();
  const source = "**unfinished";
  const streamed = compiler.compile(source, { streaming: true });
  const completed = compiler.compile(source);
  assert.notDeepEqual(streamed.nodes, completed.nodes);
  assert.deepEqual(completed, new ChatDocumentCompiler().compile(source));
  assert.equal(compiler.compile(source), completed);
  assert.deepEqual(compiler.compile(source, { streaming: true }), streamed);
});

test("completed cache is bounded by recency, characters and individual source size", () => {
  const compiler = new ChatDocumentCompiler();
  const oldest = compiler.compile("oldest");
  const recent = compiler.compile("recent");
  for (let i = 0; i < 98; i++) compiler.compile(`document ${i}`);
  assert.equal(compiler.compile("recent"), recent);
  compiler.compile("overflow");
  assert.notEqual(compiler.compile("oldest"), oldest);
  assert.equal(compiler.compile("recent"), recent);

  const largeCompiler = new ChatDocumentCompiler();
  const sources = Array.from({ length: 7 }, (_, i) => "```text\n" + i + "x".repeat(899_999) + "\n```");
  const firstLarge = largeCompiler.compile(sources[0]!);
  for (const source of sources.slice(1)) largeCompiler.compile(source);
  assert.notEqual(largeCompiler.compile(sources[0]!), firstLarge, "character budget evicts before entry budget");
  const oversized = "```text\n" + "x".repeat(1_000_001) + "\n```";
  assert.notEqual(largeCompiler.compile(oversized), largeCompiler.compile(oversized));
  compiler.clearCaches();
  assert.notEqual(compiler.compile("recent"), recent, "explicit clear releases completed syntax");
});

test("sharing syntax does not share identities or entering state across documents", () => {
  const compiler = new ChatDocumentCompiler();
  const source = "# Result\n\n**Shared syntax**";
  const syntax = compiler.compile(source);
  const a = new ChatDocumentStreamingSession("a", compiler);
  const b = new ChatDocumentStreamingSession("b", compiler);
  const first = a.compile(source);
  const second = b.compile(source);
  first.commit(); second.commit();
  assert.notEqual(first.snapshot.nodes[0]?.stableKey, second.snapshot.nodes[0]?.stableKey);
  assert.ok(flatten(syntax.nodes).every((node) => node.stableKey === ""));
  assert.equal(compiler.compile(source), syntax, "reconciliation must not mutate cached syntax");
  assert.equal(a.compile(source).snapshot, first.snapshot);
  assert.equal(b.compile(source).snapshot, second.snapshot);
  for (const snapshot of [first.snapshot, second.snapshot]) {
    assert.ok(flatten(snapshot.nodes).every((node) => !("segments" in node)
      || node.segments.every((segment) => !segment.entering)));
  }
});

test("retained completed snapshots preserve CAS and are invalidated by dialect, edits and streaming", () => {
  const session = new ChatDocumentStreamingSession("retained");
  const source = "paragraph\nnext";
  const initial = session.compile(source); initial.commit();
  const retained = session.compile(source);
  assert.equal(retained.snapshot, initial.snapshot);
  const stale = session.compile("stale");
  const newer = session.compile("newer"); newer.commit();
  retained.commit(); stale.commit();
  assert.equal(session.getSnapshot(), newer.snapshot, "old retained and abandoned candidates cannot overwrite");
  const edited = session.compile(source); edited.commit();
  assert.notEqual(edited.snapshot, initial.snapshot);
  const dialect = session.compile(source, { dialect: "user-message" }); dialect.commit();
  assert.notEqual(dialect.snapshot, edited.snapshot);
  assert.equal(session.compile(source, { dialect: "user-message" }).snapshot, dialect.snapshot);
  const stream = session.compile(source, { dialect: "user-message", streaming: true }); stream.commit();
  assert.notEqual(stream.snapshot, dialect.snapshot);
  const done = session.compile(source, { dialect: "user-message" }); done.commit();
  assert.equal(done.snapshot.streaming, false);
  assert.equal(chatDocumentPlainText(done.snapshot.nodes), chatDocumentPlainText(dialect.snapshot.nodes));
  assert.ok(flatten(done.snapshot.nodes).every((node) => !("segments" in node)
    || node.segments.every((segment) => !segment.entering)));
  assert.equal(session.compile(source, { dialect: "user-message" }).snapshot, done.snapshot);
});
