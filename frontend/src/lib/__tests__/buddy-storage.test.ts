/**
 * buddy-storage 单元测试。
 *
 * 验证 Vibebase namespace/key 拼接与 schema 校验逻辑：
 * - load：401 透传、缺失 / schema 不符返 null、命中正常返回
 * - save：JSON 序列化包含 version + updatedAt
 * - clear：调用 deleteValue
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadBuddyState,
  saveBuddyState,
  clearBuddyState,
} from "../buddy-storage";
import {
  deleteValue,
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
    deleteValue: vi.fn(),
  };
});

const mockedGetJSON = vi.mocked(getJSON);
const mockedSetJSON = vi.mocked(setJSON);
const mockedDeleteValue = vi.mocked(deleteValue);

describe("buddy-storage", () => {
  beforeEach(() => {
    mockedGetJSON.mockReset();
    mockedSetJSON.mockReset();
    mockedDeleteValue.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadBuddyState", () => {
    it("uses namespace=agent-state and key=buddy.{botId}", async () => {
      mockedGetJSON.mockResolvedValueOnce(null);
      await loadBuddyState("ins-123");
      expect(mockedGetJSON).toHaveBeenCalledWith("agent-state", "buddy.ins-123");
    });

    it("uses key=buddy.__no_bot__ when botId is null/undefined", async () => {
      mockedGetJSON.mockResolvedValueOnce(null);
      await loadBuddyState(null);
      expect(mockedGetJSON).toHaveBeenCalledWith(
        "agent-state",
        "buddy.__no_bot__",
      );
      mockedGetJSON.mockResolvedValueOnce(null);
      await loadBuddyState(undefined);
      expect(mockedGetJSON).toHaveBeenLastCalledWith(
        "agent-state",
        "buddy.__no_bot__",
      );
    });

    it("returns null when key is missing", async () => {
      mockedGetJSON.mockResolvedValueOnce(null);
      const state = await loadBuddyState("ins-1");
      expect(state).toBeNull();
    });

    it("returns null when version is not 1 (incompatible schema)", async () => {
      mockedGetJSON.mockResolvedValueOnce({
        version: 2,
        drawnSouls: [],
        appliedSlug: null,
      });
      const state = await loadBuddyState("ins-1");
      expect(state).toBeNull();
    });

    it("returns null when drawnSouls is not an array", async () => {
      mockedGetJSON.mockResolvedValueOnce({
        version: 1,
        drawnSouls: "broken" as unknown,
        appliedSlug: null,
      });
      const state = await loadBuddyState("ins-1");
      expect(state).toBeNull();
    });

    it("returns the parsed state when payload is valid", async () => {
      mockedGetJSON.mockResolvedValueOnce({
        version: 1,
        drawnSouls: [
          { slug: "a", displayName: "A", summary: "", element: "fire" },
        ],
        appliedSlug: "a",
        updatedAt: 1234,
      });
      const state = await loadBuddyState("ins-1");
      expect(state).toEqual({
        drawnSouls: [
          { slug: "a", displayName: "A", summary: "", element: "fire" },
        ],
        appliedSlug: "a",
      });
    });

    it("propagates VibebaseError (e.g. 401) to caller", async () => {
      const err = new VibebaseError("unauthorized", 401, "unauthorized");
      mockedGetJSON.mockRejectedValueOnce(err);
      await expect(loadBuddyState("ins-1")).rejects.toBe(err);
    });
  });

  describe("saveBuddyState", () => {
    it("calls setJSON with version=1 + drawnSouls + appliedSlug + updatedAt", async () => {
      mockedSetJSON.mockResolvedValueOnce({
        namespace: "agent-state",
        key: "buddy.ins-1",
        size: 0,
        updatedAt: "2024-01-01T00:00:00Z",
        created: true,
      });
      await saveBuddyState("ins-1", {
        drawnSouls: [],
        appliedSlug: null,
      });
      expect(mockedSetJSON).toHaveBeenCalledWith(
        "agent-state",
        "buddy.ins-1",
        expect.objectContaining({
          version: 1,
          drawnSouls: [],
          appliedSlug: null,
          updatedAt: expect.any(Number),
        }),
      );
    });

    it("propagates VibebaseError (e.g. 401)", async () => {
      const err = new VibebaseError("unauthorized", 401, "unauthorized");
      mockedSetJSON.mockRejectedValueOnce(err);
      await expect(
        saveBuddyState("ins-1", { drawnSouls: [], appliedSlug: null }),
      ).rejects.toBe(err);
    });
  });

  describe("clearBuddyState", () => {
    it("calls deleteValue with the right namespace + key", async () => {
      mockedDeleteValue.mockResolvedValueOnce(true);
      await clearBuddyState("ins-1");
      expect(mockedDeleteValue).toHaveBeenCalledWith(
        "agent-state",
        "buddy.ins-1",
      );
    });
  });
});
