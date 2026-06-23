import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadExpertPackagesState,
  saveExpertPackagesState,
} from "../expert-package-storage";
import {
  getJSON,
  setJSON,
  VibebaseError,
} from "../vibebase-client";

vi.mock("../vibebase-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vibebase-client")>();
  return {
    ...actual,
    getJSON: vi.fn(),
    setJSON: vi.fn(),
  };
});

const mockedGetJSON = vi.mocked(getJSON);
const mockedSetJSON = vi.mocked(setJSON);

describe("expert-package-storage", () => {
  beforeEach(() => {
    mockedGetJSON.mockReset();
    mockedSetJSON.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads state from namespace=agent-state and key=expert-packages.{botId}", async () => {
    mockedGetJSON.mockResolvedValueOnce({
      version: 1,
      installedPackageSlugs: [" tech-code-review ", "tech-code-review", "tech-test-automation"],
      updatedAt: 1234,
    });

    await expect(loadExpertPackagesState("bot-1")).resolves.toEqual({
      installedPackageSlugs: ["tech-code-review", "tech-test-automation"],
    });
    expect(mockedGetJSON).toHaveBeenCalledWith("agent-state", "expert-packages.bot-1");
  });

  it("uses key=expert-packages.__no_bot__ when botId is missing", async () => {
    mockedGetJSON.mockResolvedValueOnce(null);
    await loadExpertPackagesState(undefined);
    expect(mockedGetJSON).toHaveBeenCalledWith("agent-state", "expert-packages.__no_bot__");
  });

  it("returns null for absent or incompatible payloads", async () => {
    mockedGetJSON.mockResolvedValueOnce(null);
    await expect(loadExpertPackagesState("bot-1")).resolves.toBeNull();

    mockedGetJSON.mockResolvedValueOnce({ version: 2, installedPackageSlugs: ["a"] });
    await expect(loadExpertPackagesState("bot-1")).resolves.toBeNull();
  });

  it("saves normalized installed package slugs", async () => {
    mockedSetJSON.mockResolvedValueOnce({
      namespace: "agent-state",
      key: "expert-packages.bot-1",
      size: 0,
      updatedAt: "2026-01-01T00:00:00Z",
      created: true,
    });

    await saveExpertPackagesState("bot-1", {
      installedPackageSlugs: ["tech-code-review", " ", "tech-code-review"],
    });

    expect(mockedSetJSON).toHaveBeenCalledWith(
      "agent-state",
      "expert-packages.bot-1",
      expect.objectContaining({
        version: 1,
        installedPackageSlugs: ["tech-code-review"],
        updatedAt: expect.any(Number),
      }),
    );
  });

  it("propagates Vibebase errors", async () => {
    const err = new VibebaseError("unauthorized", 401, "unauthorized");
    mockedGetJSON.mockRejectedValueOnce(err);
    await expect(loadExpertPackagesState("bot-1")).rejects.toBe(err);
  });
});
