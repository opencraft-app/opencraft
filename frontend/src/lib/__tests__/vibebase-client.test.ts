/**
 * vibebase-client 单元测试。
 *
 * 仅测纯函数 / 边界逻辑：URL 拼接、字段映射、错误码识别、字节预校验。
 * 真实网络请求归集成测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 把 auth-api-base 锁定到固定值，独立于运行环境
vi.mock("@/lib/auth-api-base", () => ({
  resolveConfiguredAuthApiBaseUrl: vi.fn(() => "https://lightclaw.tech"),
}));

vi.mock("@/repositories/http-repositories", () => ({
  readStoredAuthToken: vi.fn(() => null),
}));

import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import {
  deleteValue,
  getJSON,
  getValue,
  listKeys,
  setJSON,
  setValue,
  VIBEBASE_MAX_NAME_BYTES,
  VIBEBASE_MAX_VALUE_BYTES,
  VibebaseError,
} from "../vibebase-client";

const ORIGINAL_FETCH = globalThis.fetch;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mockFetch(
  payload: unknown,
  status = 200,
): { fn: ReturnType<typeof vi.fn>; lastInit: () => RequestInit | undefined } {
  let init: RequestInit | undefined;
  const fn = vi.fn(async (_url: string, requestInit?: RequestInit): Promise<FakeResponse> => {
    init = requestInit;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return { fn, lastInit: () => init };
}

describe("vibebase-client", () => {
  beforeEach(() => {
    vi.mocked(resolveConfiguredAuthApiBaseUrl).mockReturnValue(
      "https://lightclaw.tech",
    );
    vi.mocked(readStoredAuthToken).mockReturnValue(null);
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  describe("URL building", () => {
    it("builds the correct URL with vibebase prefix", async () => {
      const { fn } = mockFetch({
        namespace: "ns",
        key: "k",
        size: 0,
        updated_at: "2024-01-01T00:00:00Z",
      });
      await getValue("ns", "k");
      expect(fn).toHaveBeenCalledWith(
        "https://lightclaw.tech/v1/vibebase/namespaces/ns/kv/k",
        expect.objectContaining({ method: "GET", credentials: "include" }),
      );
    });

    it("URL-encodes namespace and key", async () => {
      const { fn } = mockFetch({
        namespace: "a b",
        key: "x/y",
        size: 0,
        updated_at: "2024-01-01T00:00:00Z",
      });
      await getValue("a b", "x/y");
      expect(fn).toHaveBeenCalledWith(
        "https://lightclaw.tech/v1/vibebase/namespaces/a%20b/kv/x%2Fy",
        expect.any(Object),
      );
    });

    it("supports vite-proxy mode (empty base url)", async () => {
      vi.mocked(resolveConfiguredAuthApiBaseUrl).mockReturnValue("");
      const { fn } = mockFetch({
        namespace: "ns",
        key: "k",
        size: 0,
        updated_at: "2024-01-01T00:00:00Z",
      });
      await getValue("ns", "k");
      expect(fn).toHaveBeenCalledWith(
        "/v1/vibebase/namespaces/ns/kv/k",
        expect.any(Object),
      );
    });

    it("adds the stored bearer token while keeping credentials", async () => {
      vi.mocked(readStoredAuthToken).mockReturnValue("stored-session-token");
      const { fn, lastInit } = mockFetch({
        namespace: "ns",
        key: "k",
        size: 0,
        updated_at: "2024-01-01T00:00:00Z",
      });
      await getValue("ns", "k");
      expect(fn).toHaveBeenCalledWith(
        "https://lightclaw.tech/v1/vibebase/namespaces/ns/kv/k",
        expect.objectContaining({ method: "GET", credentials: "include" }),
      );
      const headers = new Headers(lastInit()?.headers);
      expect(headers.get("Authorization")).toBe("Bearer stored-session-token");
    });

    it("throws when api base is not configured (mock mode)", async () => {
      vi.mocked(resolveConfiguredAuthApiBaseUrl).mockReturnValue(null);
      await expect(getValue("ns", "k")).rejects.toBeInstanceOf(VibebaseError);
    });
  });

  describe("getValue", () => {
    it("returns the entry mapped to camelCase", async () => {
      mockFetch({
        namespace: "ns",
        key: "k",
        value: "hello",
        size: 5,
        updated_at: "2024-01-01T00:00:00Z",
      });
      const entry = await getValue("ns", "k");
      expect(entry).toEqual({
        namespace: "ns",
        key: "k",
        value: "hello",
        size: 5,
        updatedAt: "2024-01-01T00:00:00Z",
      });
    });

    it("returns null on 404", async () => {
      mockFetch({ error: "not_found" }, 404);
      const entry = await getValue("ns", "missing");
      expect(entry).toBeNull();
    });

    it("throws VibebaseError with isUnauthorized=true on 401", async () => {
      mockFetch({ error: "unauthorized" }, 401);
      await expect(getValue("ns", "k")).rejects.toMatchObject({
        name: "VibebaseError",
        status: 401,
        code: "unauthorized",
        isUnauthorized: true,
      });
    });

    it("throws VibebaseError with status=0 on network error", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof globalThis.fetch;
      await expect(getValue("ns", "k")).rejects.toMatchObject({
        status: 0,
        code: "network_error",
      });
    });
  });

  describe("setValue", () => {
    it("PUTs with text/plain content type and credentials", async () => {
      const { fn, lastInit } = mockFetch({
        namespace: "ns",
        key: "k",
        size: 5,
        updated_at: "2024-01-01T00:00:00Z",
        created: true,
      });
      const result = await setValue("ns", "k", "hello");
      expect(fn).toHaveBeenCalledWith(
        "https://lightclaw.tech/v1/vibebase/namespaces/ns/kv/k",
        expect.objectContaining({
          method: "PUT",
          credentials: "include",
          body: "hello",
        }),
      );
      const init = lastInit();
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(result).toEqual({
        namespace: "ns",
        key: "k",
        size: 5,
        updatedAt: "2024-01-01T00:00:00Z",
        created: true,
      });
    });

    it("rejects locally when value exceeds 5000 bytes (no fetch)", async () => {
      const { fn } = mockFetch({}, 200);
      const tooBig = "x".repeat(VIBEBASE_MAX_VALUE_BYTES + 1);
      await expect(setValue("ns", "k", tooBig)).rejects.toMatchObject({
        status: 413,
        code: "value_too_large",
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("counts utf-8 bytes for size validation (multi-byte chars)", async () => {
      const { fn } = mockFetch({}, 200);
      // 中文 1 字 = 3 字节，1667 字 = 5001 字节 → 应被拒
      const tooBig = "中".repeat(1667);
      await expect(setValue("ns", "k", tooBig)).rejects.toMatchObject({
        status: 413,
        code: "value_too_large",
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("propagates 409 quota_exceeded from server", async () => {
      mockFetch({ error: "quota_exceeded" }, 409);
      await expect(setValue("ns", "k", "v")).rejects.toMatchObject({
        status: 409,
        code: "quota_exceeded",
      });
    });
  });

  describe("deleteValue", () => {
    it("returns true on 204", async () => {
      // 204 没有 body，但服务器允许 ok=true 即可
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 204,
        json: async () => ({}),
      })) as unknown as typeof globalThis.fetch;
      const ok = await deleteValue("ns", "k");
      expect(ok).toBe(true);
    });

    it("returns false on 404 (idempotent)", async () => {
      mockFetch({ error: "not_found" }, 404);
      const ok = await deleteValue("ns", "missing");
      expect(ok).toBe(false);
    });
  });

  describe("listKeys", () => {
    it("appends limit and cursor as query params", async () => {
      const { fn } = mockFetch({
        items: [],
        next_cursor: "",
      });
      await listKeys("ns", { limit: 50, cursor: "abc" });
      expect(fn).toHaveBeenCalledWith(
        "https://lightclaw.tech/v1/vibebase/namespaces/ns/kv?limit=50&cursor=abc",
        expect.any(Object),
      );
    });

    it("maps next_cursor to nextCursor and items to camelCase", async () => {
      mockFetch({
        items: [
          {
            namespace: "ns",
            key: "k1",
            size: 1,
            updated_at: "2024-01-01T00:00:00Z",
          },
        ],
        next_cursor: "cur1",
      });
      const page = await listKeys("ns");
      expect(page.nextCursor).toBe("cur1");
      expect(page.items[0]).toEqual({
        namespace: "ns",
        key: "k1",
        size: 1,
        updatedAt: "2024-01-01T00:00:00Z",
        value: undefined,
      });
    });
  });

  describe("name validation", () => {
    it("rejects empty namespace before any fetch", async () => {
      const { fn } = mockFetch({}, 200);
      await expect(getValue("", "k")).rejects.toMatchObject({
        code: "namespace_required",
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("rejects too-long namespace before any fetch", async () => {
      const { fn } = mockFetch({}, 200);
      const tooLong = "a".repeat(VIBEBASE_MAX_NAME_BYTES + 1);
      await expect(getValue(tooLong, "k")).rejects.toMatchObject({
        code: "namespace_too_large",
      });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("getJSON / setJSON", () => {
    it("setJSON serializes data and calls setValue", async () => {
      const { fn, lastInit } = mockFetch({
        namespace: "ns",
        key: "k",
        size: 13,
        updated_at: "2024-01-01T00:00:00Z",
        created: false,
      });
      await setJSON("ns", "k", { a: 1, b: "two" });
      expect(fn).toHaveBeenCalled();
      expect(lastInit()?.body).toBe('{"a":1,"b":"two"}');
    });

    it("getJSON parses the value", async () => {
      mockFetch({
        namespace: "ns",
        key: "k",
        value: '{"x":42}',
        size: 8,
        updated_at: "2024-01-01T00:00:00Z",
      });
      const data = await getJSON<{ x: number }>("ns", "k");
      expect(data).toEqual({ x: 42 });
    });

    it("getJSON returns null when key not found", async () => {
      mockFetch({ error: "not_found" }, 404);
      const data = await getJSON("ns", "missing");
      expect(data).toBeNull();
    });

    it("getJSON returns null when value is malformed JSON (does not throw)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch({
        namespace: "ns",
        key: "k",
        value: "not-json",
        size: 8,
        updated_at: "2024-01-01T00:00:00Z",
      });
      const data = await getJSON("ns", "k");
      expect(data).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
