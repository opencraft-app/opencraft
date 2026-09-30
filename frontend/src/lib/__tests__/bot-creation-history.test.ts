import { beforeEach, describe, expect, it } from "vitest";

import { hasEverCreatedBot, markBotCreated } from "@/lib/bot-creation-history";

describe("bot creation history", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats an account without a creation record as first-time", () => {
    expect(hasEverCreatedBot("user-1")).toBe(false);
  });

  it("remembers a successful creation per account", () => {
    markBotCreated("user-1");

    expect(hasEverCreatedBot("user-1")).toBe(true);
  });

  it("does not treat another account as non-first-time", () => {
    markBotCreated("user-1");

    expect(hasEverCreatedBot("user-2")).toBe(false);
  });

  it("keeps the non-first-time state after all bots are deleted", () => {
    markBotCreated("user-1");

    expect(hasEverCreatedBot("user-1")).toBe(true);
  });
});
