import { describe, expect, it } from "vitest"

import config from "./vite.config"

describe("vite dev proxy", () => {
  it("proxies embedded new-api console assets to llmgateway backend", () => {
    const proxy = typeof config === "object" ? config.server?.proxy : undefined

    expect(proxy).toMatchObject({
      "/api": "http://localhost:18080",
      "/_llmgateway_console": "http://localhost:18080",
    })
  })

  it("proxies OpenAI-compatible traffic to the traffic process", () => {
    const proxy = typeof config === "object" ? config.server?.proxy : undefined

    expect(proxy).toMatchObject({
      "/v1": "http://localhost:18082",
    })
  })
})
