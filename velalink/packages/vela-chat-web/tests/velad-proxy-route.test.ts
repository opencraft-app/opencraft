import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../../app/chat/api/velad/[...path]/route";

test("chat velad proxy returns structured gateway error when local velad is unavailable", async () => {
  const previous = process.env.VELAD_BASE_URL;
  process.env.VELAD_BASE_URL = "http://127.0.0.1:9";

  try {
    const response = await GET(new Request("http://localhost/chat/api/velad/api/v1/backends"), {
      params: Promise.resolve({ path: ["api", "v1", "backends"] }),
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "velad_unavailable");
    assert.match(body.error.message, /velad/i);
  } finally {
    if (previous === undefined) {
      delete process.env.VELAD_BASE_URL;
    } else {
      process.env.VELAD_BASE_URL = previous;
    }
  }
});
