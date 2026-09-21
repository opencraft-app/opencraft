import assert from "node:assert/strict";
import test from "node:test";

import {
  inlineVisualizationDirective,
  helloWorldHtml,
  materializeHelloWorld,
  VisualizationProjectionService,
} from "../src/services/visualization-projection.ts";
import { utf8Decode } from "../src/runtime/bytes.ts";

const nativeVisualizationPathPattern = /(?:^|[\\/])\.codex[\\/]visualizations[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]([a-zA-Z0-9_-]+)[\\/][a-z0-9]+(?:-[a-z0-9]+)*\.html$/;

test("hello world visualization is a native HTML fragment and escapes user data", () => {
  const html = helloWorldHtml('<alice & bob>');
  assert.match(html, /^<div id="hypernode-hello-world">/);
  assert.match(html, /Hello World!/);
  assert.match(html, /&lt;alice &amp; bob&gt;/);
  assert.doesNotMatch(html, /<alice & bob>/);
  assert.doesNotMatch(html, /<!doctype|<html|<head|<body/i);
  assert.match(html, /<script>/i);
  assert.doesNotMatch(html, /src=["']https?:/);
  assert.match(html, /<button type="button">点我试试<\/button>/);
  assert.doesNotMatch(html, /<details|<summary/i);
});

test("inline visualization directive uses the native Desktop contract", () => {
  assert.equal(
    inlineVisualizationDirective("/workspace/.codex/visualizations/2026/08/27/thread/hello-world.html"),
    'visualize{"path":"/workspace/.codex/visualizations/2026/08/27/thread/hello-world.html"}',
  );
});

test("projection materializes a user-scoped VFS page and returns its directive", () => {
  const writes = [];
  const directories = [];
  const user = { id: "user:alice", username: "alice", homePath: "/users/alice" };
  const ctx = {
    userDirectory: { find: (id) => id === user.id ? user : null },
    virtualFilesystem: {
      createDirectory: (params, owner) => directories.push({ params, owner }),
      writeFile: (params, bytes, owner) => writes.push({ params, bytes, owner }),
    },
  };

  const message = materializeHelloWorld(ctx, {
    connection: { identity: { id: user.id } },
    threadId: "01a038a0-2c60-72ca-970b-53b8a9b58edd",
    turnId: "01a03f7d-6d98-7d28-9b12-b2d5a42b42d5",
  });

  const service = Object.create(VisualizationProjectionService.prototype);
  service.ctx = ctx;
  assert.equal(service.helloWorld({
    connection: { identity: { id: user.id } },
    threadId: "01a038a0-2c60-72ca-970b-53b8a9b58edd",
    turnId: "01a03f7d-6d98-7d28-9b12-b2d5a42b42d5",
  }), message);

  assert.equal(directories.length, 2);
  assert.equal(writes.length, 2);
  assert.equal(directories[0].params.path, "/localhost/.codex/visualizations/2026/08/25/01a038a0-2c60-72ca-970b-53b8a9b58edd");
  assert.equal(writes[0].params.path, "/localhost/.codex/visualizations/2026/08/25/01a038a0-2c60-72ca-970b-53b8a9b58edd/hello-world-01a03f7d-6d98-7d28-9b12-b2d5a42b42d5.html");
  assert.equal(writes[0].owner, user);
  assert.match(utf8Decode(writes[0].bytes), /binary-octal-relationship/);
  assert.match(utf8Decode(writes[0].bytes), /二进制与八进制/);
  assert.match(message, /visualize\{"path":"\/workspace\/\.codex\/visualizations\/2026\/08\/25\/01a038a0-2c60-72ca-970b-53b8a9b58edd\/hello-world-01a03f7d-6d98-7d28-9b12-b2d5a42b42d5\.html"/);
  const publicPath = JSON.parse(message.match(/visualize(\{.*\})/)?.[1] ?? "null")?.path;
  assert.equal(publicPath?.match(nativeVisualizationPathPattern)?.[1], "01a038a0-2c60-72ca-970b-53b8a9b58edd");
});

test("projection rejects a non-UUIDv7 thread because Desktop cannot authorize its visualization path", () => {
  assert.throws(() => materializeHelloWorld({
    userDirectory: { find: () => ({ username: "alice" }) },
  }, {
    connection: { identity: { id: "user:alice" } },
    threadId: "not-a-thread",
  }), /UUIDv7 thread id/);
});
