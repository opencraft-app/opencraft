import assert from "node:assert/strict";
import test from "node:test";
import { resolveStandardChatResource } from "../../packages/chat-render-react/src/resource-target";
import { parseWorkspaceResource } from "../../apps/workbench-web/src/panels/workspace-resource-model";
import { ChatDocumentCompiler } from "../../packages/chat-document/src/compiler";
import { mediaMimeType } from "../../apps/workbench-web/src/runtime/appserver-media-loader";
import { chatMediaMimeType } from "../../packages/chat-render-react/src/resource-media";
import { Context } from "@deepseek-ai/cordis";
import { ChatResourcePolicyService } from "../../packages/chat-render-react/src/services/resource-policy-service";
import { registerStandardChatResourcePolicy } from "../../packages/chat-render-react/src/resource-target";

const context = { cwd: "/home/agentuser/output", externalResourcePolicy: "allow" as const };

for (const [source, path, fragment] of [
  ["[report](./report%20final.md)", "/home/agentuser/output/report final.md", ""],
  ["![图](./image%20one.png)", "/home/agentuser/output/image one.png", ""],
  ["[report](./report.md#summary)", "/home/agentuser/output/report.md", "#summary"],
  ["[report](./report%2520final.md)", "/home/agentuser/output/report%20final.md", ""],
  ["[report](./report%231.md#summary)", "/home/agentuser/output/report#1.md", "#summary"],
]) {
  test(`Markdown URL destinations retain encoded path and fragment semantics: ${source}`, () => {
    const document = new ChatDocumentCompiler().compile(source!);
    const node = document.nodes[0];
    assert.ok(node && "children" in node);
    const targetNode = node.children.find((child) => child.kind === "link" || child.kind === "image");
    assert.ok(targetNode?.kind === "link" || targetNode?.kind === "image");
    const destination = targetNode.kind === "link" ? targetNode.href : targetNode.src;
    const decision = resolveStandardChatResource(destination, context, "url");
    assert.equal(parseWorkspaceResource(decision.target!).path, path);
    assert.equal(new URL(decision.target!).hash, fragment);
  });
}

test("URL cwd stays literal while destinations preserve encoding and line references", () => {
  const ctx = { ...context, cwd: "/workspace/root#%20" };
  const decision = resolveStandardChatResource("./report%20final.md#L12C3", ctx, "url");
  assert.deepEqual(parseWorkspaceResource(decision.target!), {
    path: "/workspace/root#%20/report final.md",
    line: 12,
    column: 3,
  });
  assert.equal(
    resolveStandardChatResource("https://example.com/a%20b#summary", context, "url").target,
    "https://example.com/a%20b#summary",
  );
  assert.equal(resolveStandardChatResource("javascript:alert(1)", context, "url").allowed, false);
});

for (const [cwd, source, path] of [
  ["D:/", "[报告](../report.md)", "D:/report.md"],
  ["D:/", "[报告](../../../report.md)", "D:/report.md"],
  ["D:/", "[报告](./report.md)", "D:/report.md"],
  ["D:\\", "[报告](../report.md)", "D:/report.md"],
  ["d:/docs/project", "[报告](../../../report.md)", "d:/report.md"],
  ["D:\\docs\\project", "[报告](../report%20final.md#summary)", "D:/docs/report final.md"],
  ["D:/docs/project", "![图](../../image%20one.png)", "D:/image one.png"],
  ["D:/docs#%20/project", "[报告](../report%2520final.md#L12C3)", "D:/docs#%20/report%20final.md"],
  ["D:/repo", "[报告](/C:/report.md)", "C:/report.md"],
  ["D:/repo", "[报告](/c:/report%20final.md#summary)", "c:/report final.md"],
  ["D:/repo", "[报告](C:/report.md)", "C:/report.md"],
  ["D:/repo", "[报告](/report.md)", "D:/report.md"],
  ["D:/repo", "[报告](./C:/report.md)", "D:/repo/C:/report.md"],
]) {
  test(`Windows Markdown URLs retain the drive through root and parent resolution: ${cwd} ${source}`, () => {
    const document = new ChatDocumentCompiler().compile(source!);
    const node = document.nodes[0];
    assert.ok(node && "children" in node);
    const targetNode = node.children.find((child) => child.kind === "link" || child.kind === "image");
    assert.ok(targetNode?.kind === "link" || targetNode?.kind === "image");
    const destination = targetNode.kind === "link" ? targetNode.href : targetNode.src;
    const decision = resolveStandardChatResource(destination, { ...context, cwd }, "url");
    assert.equal(parseWorkspaceResource(decision.target!).path, path);
    assert.match(new URL(decision.target!).pathname, /^\/[a-z]:\//iu);
    assert.equal(new URL(decision.target!).hash, /#.*$/u.exec(destination)?.[0] ?? "");
  });
}

test("a drive-like POSIX directory remains a literal directory", () => {
  const decision = resolveStandardChatResource("../../report.md", { ...context, cwd: "/D:/docs" }, "url");
  assert.equal(parseWorkspaceResource(decision.target!).path, "/report.md");
});

test("resource policies receive input syntax without bypassing their priority or restrictions", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(ChatResourcePolicyService);
  await fiber;
  const renderContext = {
    ...context,
    documentId: "syntax-test",
    theme: "light" as const,
    streaming: false,
    allowWideBlocks: false,
  };
  try {
    registerStandardChatResourcePolicy(ctx.chatResourcePolicies, "standard-test");
    const url = ctx.chatResourcePolicies.resolve("./report%20final.md", renderContext, "url");
    const path = ctx.chatResourcePolicies.resolve("./report%20final.md", renderContext);
    assert.equal(parseWorkspaceResource(url.target!).path, "/home/agentuser/output/report final.md");
    assert.equal(parseWorkspaceResource(path.target!).path, "/home/agentuser/output/report%20final.md");
    assert.equal(
      ctx.chatResourcePolicies.resolve(
        "https://example.com",
        { ...renderContext, externalResourcePolicy: "restricted" },
        "url",
      ).allowed,
      false,
    );
    ctx.chatResourcePolicies.register({
      name: "host-test",
      priority: 10,
      matches: (_target, _context, syntax) => syntax === "url",
      resolve: (_target, _context, syntax) => ({ allowed: false, target: null, reason: `Host blocked ${syntax}` }),
    });
    assert.equal(
      ctx.chatResourcePolicies.resolve("./report%20final.md", renderContext, "url").reason,
      "Host blocked url",
    );
    assert.equal(ctx.chatResourcePolicies.resolve("./report%20final.md", renderContext).allowed, true);
  } finally {
    await fiber.dispose();
  }
});

for (const path of [
  "/home/agentuser/output/report#1.pdf",
  "/home/agentuser/output/report%20final.md",
  "/home/agentuser/output/report%23final.md",
  "/home/agentuser/output/report?draft.md",
  "/home/agentuser/output/报告 final (1).md",
]) {
  test(`raw automatic-link path reaches the exact Host file: ${path}`, () => {
    const resolved = resolveStandardChatResource(path, context);
    assert.equal(resolved.kind, "file");
    assert.equal(parseWorkspaceResource(resolved.target!).path, path);
  });
}

test("relative paths and cwd characters are encoded independently of location fragments", () => {
  const resolved = resolveStandardChatResource("report%20#1.md:12:3", { ...context, cwd: "/workspace/a#b%20" });
  assert.deepEqual(parseWorkspaceResource(resolved.target!), {
    path: "/workspace/a#b%20/report%20#1.md",
    line: 12,
    column: 3,
  });
  assert.ok(resolved.target!.endsWith("#L12C3"));
});

test("Windows automatic paths and Windows cwd retain their exact decoded identity", () => {
  for (const [path, cwd] of [
    ["C:\\docs\\report%20#1.md", null],
    ["report%20#1.md", "C:\\docs"],
  ]) {
    const resolved = resolveStandardChatResource(path!, { ...context, cwd });
    assert.equal(parseWorkspaceResource(resolved.target!).path, "C:/docs/report%20#1.md");
  }
});

test("workspaces with trailing separators resolve relative paths and URLs to the same file", () => {
  for (const [cwd, expected] of [
    ["/workspace///", "/workspace/report.md"],
    ["C:////", "C:/report.md"],
    ["///", "/report.md"],
  ] as const) {
    for (const syntax of ["path", "url"] as const) {
      const resolved = resolveStandardChatResource("report.md", { ...context, cwd }, syntax);
      assert.equal(parseWorkspaceResource(resolved.target!).path, expected);
    }
  }
});

test("explicit file URLs keep one decoding pass and existing line references", () => {
  for (const [url, path] of [
    ["file:///workspace/report%231.md#L12C3", "/workspace/report#1.md"],
    ["file:///workspace/report%2520final.md", "/workspace/report%20final.md"],
    ["file:///workspace/report%20final.md", "/workspace/report final.md"],
  ]) {
    const resolved = resolveStandardChatResource(url!, context);
    assert.equal(resolved.target, url);
    assert.equal(parseWorkspaceResource(resolved.target!).path, path);
  }
  const line = resolveStandardChatResource("src/main.ts#L12C3", context);
  assert.equal(line.target, "file:///home/agentuser/output/src/main.ts#L12C3");
});

test("Host filenames preserve URL delimiters when inferring a MIME hint", () => {
  assert.equal(mediaMimeType("/workspace/image#1.svg"), "image/svg+xml");
  assert.equal(mediaMimeType("/workspace/image?draft.svg"), "image/svg+xml");
  assert.equal(chatMediaMimeType("https://example.test/image.png?name=slide.svg#state"), "image/png");
});

test("explicit URL syntax retains scheme checks and existing app routes", () => {
  assert.equal(resolveStandardChatResource("unknown:report.pdf", context, "url").allowed, false);
  assert.equal(resolveStandardChatResource("file:///workspace/invalid%zz.pdf", context, "url").allowed, false);
  assert.equal(resolveStandardChatResource("opencraft://conversation/v1/test", context, "url").kind, "app-route");
});
