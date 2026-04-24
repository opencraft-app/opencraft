import test from "node:test";
import assert from "node:assert/strict";

process.env.GATEWAY_API_URL = "https://gateway.example.com";

// Node's test runner needs the explicit .ts extension here; TypeScript bundler mode rejects it.
// @ts-expect-error Node's test runner needs the explicit .ts extension here.
const { buildGeminiRequest, buildProxyResponseHeaders } = await import("./route-helpers.ts");

test("buildGeminiRequest rejects URL images instead of fetching them server-side", async () => {
  await assert.rejects(
    buildGeminiRequest({
      api_key: "test-key",
      model: "gemini-2.0-flash",
      message: "describe",
      api_format: "gemini",
      images: [
        {
          id: "img-1",
          type: "url",
          data: "http://169.254.169.254/latest/meta-data",
        },
      ],
    }, process.env.GATEWAY_API_URL!),
    /URL images are not allowed for Gemini/i
  );
});

test("buildProxyResponseHeaders forwards fallback headers from upstream success responses", async () => {
  const upstream = new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "kimi-k2.5",
      choices: [{ message: { content: "ok" } }],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ai-gateway-original-model": "DeepSeek-V3.1",
        "x-ai-gateway-resolved-model": "kimi-k2.5",
        "x-ai-gateway-model-fallback": "true",
        "x-ai-gateway-fallback-reason": "no_available_provider",
      },
    }
  );

  const headers = buildProxyResponseHeaders(upstream, "application/json");
  assert.equal(headers.get("x-ai-gateway-original-model"), "DeepSeek-V3.1");
  assert.equal(headers.get("x-ai-gateway-resolved-model"), "kimi-k2.5");
  assert.equal(headers.get("x-ai-gateway-model-fallback"), "true");
  assert.equal(headers.get("x-ai-gateway-fallback-reason"), "no_available_provider");
});
