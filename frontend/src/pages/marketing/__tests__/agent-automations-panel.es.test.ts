import { describe, expect, it } from "vitest";

import es from "@/i18n/generated/es.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";

import spanishJobCopy from "./fixtures/agent-automations-job-copy.es.json";

describe("Agent automations Spanish Job terminology", () => {
  it.each(Object.entries(spanishJobCopy))("uses Job terminology for %s", (source, expectedSpanish) => {
    const key = (zhToKey as Record<string, string>)[source];

    expect(key).toBeTruthy();
    expect((es as Record<string, string>)[key!]).toBe(expectedSpanish);
  });
});
