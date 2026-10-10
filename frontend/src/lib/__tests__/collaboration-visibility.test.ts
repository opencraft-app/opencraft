import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_SHOWN_KEY, isCollaborationShown, setCollaborationShown, isCollaborationEnvironment } from "@/lib/collaboration-visibility";

const environment = vi.hoisted(() => ({ base: "https://lightclaw.tech" }));
vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => environment.base }));

afterEach(() => { setCollaborationShown(false); window.localStorage.removeItem(COLLABORATION_SHOWN_KEY); });

describe("hidden collaboration laboratory", () => {
  it("only allows Beijing, without opening Shanghai or international services", () => {
    environment.base = "https://api.lightvela.com";
    expect(isCollaborationEnvironment()).toBe(false);
    environment.base = "https://api.lightvela.ai";
    expect(isCollaborationEnvironment()).toBe(false);
    environment.base = "https://lightclaw.tech";
    expect(isCollaborationEnvironment()).toBe(true);
  });
  it("defaults hidden and only opens on explicit show", () => {
    expect(isCollaborationShown()).toBe(false);
    setCollaborationShown(true);
    expect(isCollaborationShown()).toBe(true);
    setCollaborationShown(false);
    expect(isCollaborationShown()).toBe(false);
  });
  it("rejects malformed stored values", () => {
    window.localStorage.setItem(COLLABORATION_SHOWN_KEY, "not-a-boolean");
    expect(isCollaborationShown()).toBe(false);
  });
});
