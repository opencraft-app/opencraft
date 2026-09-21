import assert from "node:assert/strict";
import test from "node:test";

import { HttpIngressService } from "../src/services/http-ingress.js";

function dashboardHtml() {
  const service = Object.create(HttpIngressService.prototype);
  return new TextDecoder().decode(service.route("GET", "/", new Uint8Array()));
}

test("dashboard submit retains its form across the async request boundary", () => {
  const html = dashboardHtml();

  assert.match(html, /const form=event\.currentTarget,username=users\.value,values=Object\.fromEntries\(new FormData\(form\)\)/);
  assert.match(html, /form\.querySelectorAll\('input\[type=password\]'\)/);
  assert.doesNotMatch(html, /await fetch[\s\S]*event\.currentTarget\.querySelectorAll/);
});

for (const operation of ["responses", "chat/completions"]) test(`the shared 9988 ingress dispatches ${operation} traffic by HTTP path`, () => {
  const calls = [];
  const service = Object.create(HttpIngressService.prototype);
  service.connections = new Map();
  service.ctx = {
    modelGatewayIngress: {
      open(metadata) { calls.push(["open", metadata.connectionId]); return { allow: true, stdoutBytes: [] }; },
      data(metadata) { calls.push(["data", new TextDecoder().decode(Uint8Array.from(metadata.dataBytes))]); return { allow: true, stdoutBytes: [] }; },
    },
  };
  const metadata = { connectionId: "gateway-on-9988" };
  service.open(metadata);
  service.data({
    ...metadata,
    dataBytes: new TextEncoder().encode(
      `POST /providers/kimi/v1/${operation} HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}`,
    ),
  });
  assert.equal(service.connections.get(metadata.connectionId).mode, "model-gateway");
  assert.deepEqual(calls.map(([name]) => name), ["open", "data"]);
  assert.match(calls[1][1], new RegExp(`^POST /providers/kimi/v1/${operation}`));
});
