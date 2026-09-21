import assert from "node:assert/strict";
import test from "node:test";

import { HttpClientService, HttpResponseDecoder } from "../src/services/http-client.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("HTTP decoder preserves a content-length body split across TCP reads", () => {
  const response = new HttpResponseDecoder();
  let result = response.push(encoder.encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"));
  assert.equal(result.status, 200);
  assert.equal(decoder.decode(Uint8Array.from(result.dataBytes)), "he");
  assert.equal(result.closed, false);
  result = response.push(encoder.encode("llo"));
  assert.equal(decoder.decode(Uint8Array.from(result.dataBytes)), "llo");
  assert.equal(result.closed, true);
});

test("HTTP decoder handles chunked SSE split at arbitrary boundaries", () => {
  const response = new HttpResponseDecoder();
  const parts = [
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r",
    "\ndata\r\n3\r\n: x\r\n0\r\n",
    "\r\n",
  ];
  let output = "";
  let result;
  for (const part of parts) {
    result = response.push(encoder.encode(part));
    output += decoder.decode(Uint8Array.from(result.dataBytes));
  }
  assert.equal(output, "data: x");
  assert.equal(result.closed, true);
});

test("HTTP decoder uses connection close framing when no length is present", () => {
  const response = new HttpResponseDecoder();
  let result = response.push(encoder.encode("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nupstream"));
  assert.equal(decoder.decode(Uint8Array.from(result.dataBytes)), "upstream");
  assert.equal(result.closed, false);
  result = response.push([], true);
  assert.equal(result.closed, true);
});

test("HTTP client does not half-close TLS after a content-length request", () => {
  const writes = [];
  let halfCloses = 0;
  const service = Object.create(HttpClientService.prototype);
  service.requests = new Map();
  service.ctx = { outboundTcp: {
    connect() { return {}; },
    claimTransport() {
      return {
        write(bytes) { writes.push(Uint8Array.from(bytes)); },
        closeWrite() { halfCloses += 1; },
        drain() { return { dataBytes: [], closed: false, error: null }; },
        close() {},
      };
    },
  } };
  service.open("tls-request", {
    method: "POST",
    url: "https://provider.example/v1/chat/completions",
    body: "{}",
  });
  assert.equal(halfCloses, 0);
  assert.match(decoder.decode(writes[0]), /Content-Length: 2\r\n/);
  service.close("tls-request");
});
