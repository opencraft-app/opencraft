import assert from "node:assert/strict";
import test from "node:test";
import { ChatDocumentCompiler } from "@opencraft/chat-document";
import { visualizationCsp, visualizationDocument } from "../../packages/chat-render-web/src/renderers/visualization/sandbox";
const marker = (value: unknown) => `\uE200visualize\uE202${JSON.stringify(value)}\uE201`;
const source = marker({ path: "/workspace/output/diagram.html", mode: "wide", title: "Diagram" });
test("assistant content reference creates a visualization between paragraphs", () => {
  const nodes = new ChatDocumentCompiler().compile(`Before\n${source}\nAfter`).nodes;
  assert.deepEqual(nodes.map(node => node.kind), ["paragraph", "directive", "paragraph"]);
  assert.equal(nodes[1]?.kind === "directive" && nodes[1].attributes.path, "/workspace/output/diagram.html");
});
test("streaming reference only appears after its closing sentinel", () => {
  for (let end = 0; end < source.length; end++) {
    const parsed = new ChatDocumentCompiler().compile(source.slice(0, end), { streaming: true });
    assert.ok(!parsed.nodes.some(node => node.kind === "directive"));
  }
  assert.equal(new ChatDocumentCompiler().compile(source, { streaming: true }).nodes[0]?.kind, "directive");
});
test("code samples and user messages never execute visualization references", () => {
  for (const text of [`\`${source}\``, `\`\`\`text\n${source}\n\`\`\``]) {
    const nodes = new ChatDocumentCompiler().compile(text).nodes;
    assert.ok(!nodes.some(node => node.kind === "directive"));
  }
  assert.ok(!new ChatDocumentCompiler().compile(source, { dialect: "user-message" }).nodes.some(node => node.kind === "directive"));
});
test("invalid paths, oversized title, wrong modes and malformed JSON stay literal", () => {
  for (const value of [{ path: "https://example.com/a.html" }, { path: "//server/a.html" }, { path: "/a.txt" },
    { path: "/a.html", mode: "fullscreen" }, { path: "/a.html", title: "x".repeat(251) }]) {
    assert.ok(!new ChatDocumentCompiler().compile(marker(value)).nodes.some(node => node.kind === "directive"));
  }
});
test("sandbox enforces opaque, network-limited rendering before untrusted markup", () => {
  const html = visualizationDocument('<script>window.parent.document.body.remove()</script>', "dark", { foreground: "red</style><script>bad()</script>" });
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("window.parent"));
  assert.match(visualizationCsp, /connect-src 'none'/);
  assert.match(visualizationCsp, /frame-src 'none'/);
  assert.doesNotMatch(html, /red<\/style>/);
});
