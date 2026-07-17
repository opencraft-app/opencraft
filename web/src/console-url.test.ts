import { describe, expect, it } from "vitest"

import { consoleFrameURL } from "./console-url"

describe("consoleFrameURL", () => {
  it("opens the embedded new-api console on the authenticated dashboard route", () => {
    expect(consoleFrameURL("set-a", "18081")).toBe(
      "http://localhost:18080/_llmgateway_console/set-a/dashboard",
    )
    expect(consoleFrameURL("set/a", "18080")).toBe(
      "/_llmgateway_console/set%2Fa/dashboard",
    )
  })

  it("can deep link to a concrete new-api console page for a set", () => {
    expect(consoleFrameURL("set-a", "/users", "18081")).toBe(
      "http://localhost:18080/_llmgateway_console/set-a/users",
    )
    expect(consoleFrameURL("set/a", "/channels?status=enabled", "18080")).toBe(
      "/_llmgateway_console/set%2Fa/channels?status=enabled",
    )
  })
})
