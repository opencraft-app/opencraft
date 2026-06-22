/**
 * skillhub-api 单元测试
 *
 * 仅测可纯函数验证的部分：URL 拼接、参数序列化、错误处理。
 * 不测真实网络请求 —— 跨域、CORS、SkillHub 后端可用性归集成测试 / 手测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSkillFile,
  fetchSkillFiles,
  fetchSkillSetDetail,
  fetchSkillSets,
  fetchSoulDetail,
  fetchSouls,
} from "./skillhub-api";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(payload: unknown, status = 200): typeof globalThis.fetch {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => payload,
    text: async () => String(payload),
  })) as unknown as typeof globalThis.fetch;
  globalThis.fetch = fn;
  return fn;
}

describe("skillhub-api", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  describe("fetchSouls", () => {
    let fetchMock: typeof globalThis.fetch;
    beforeEach(() => {
      fetchMock = mockFetch({ souls: [] });
    });

    it("uses the SkillHub public souls endpoint", async () => {
      await fetchSouls();
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/souls");
    });

    it("appends paging query parameters", async () => {
      await fetchSouls({ page: 2, pageSize: 30 });
      expect(fetchMock).toHaveBeenCalledWith(
        "/__skillhub/api/v1/souls?page=2&pageSize=30",
      );
    });
  });

  describe("fetchSoulDetail", () => {
    it("URL-encodes the slug", async () => {
      const fetchMock = mockFetch({ slug: "a b" });
      await fetchSoulDetail("a b");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/souls/a%20b");
    });
  });

  describe("fetchSkillSets", () => {
    it("uses the SkillHub public skillsets endpoint", async () => {
      const fetchMock = mockFetch({ skillSets: [] });
      await fetchSkillSets();
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/skillsets");
    });

    it("appends scene, keyword and paging query parameters", async () => {
      const fetchMock = mockFetch({ skillSets: [] });
      await fetchSkillSets({ scene: "finance", keyword: " report ", page: 2, pageSize: 6 });
      expect(fetchMock).toHaveBeenCalledWith(
        "/__skillhub/api/v1/skillsets?keyword=report&scene=finance&page=2&pageSize=6",
      );
    });
  });

  describe("fetchSkillSetDetail", () => {
    it("URL-encodes the slug", async () => {
      const fetchMock = mockFetch({ slug: "finance pack", skillSlugs: [] });
      await fetchSkillSetDetail("finance pack");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/skillsets/finance%20pack");
    });
  });

  describe("fetchSkillFiles", () => {
    it("uses the SkillHub public skill files endpoint", async () => {
      const fetchMock = mockFetch({ files: [{ path: "SKILL.md", size: 1, sha256: "abc" }] });
      await expect(fetchSkillFiles("tdd guide")).resolves.toEqual([{ path: "SKILL.md", size: 1, sha256: "abc" }]);
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/skills/tdd%20guide/files");
    });
  });

  describe("fetchSkillFile", () => {
    it("URL-encodes the slug and path", async () => {
      const fetchMock = mockFetch("# Skill");
      await fetchSkillFile("tdd guide", "docs/SKILL.md");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub/api/v1/skills/tdd%20guide/file?path=docs%2FSKILL.md");
    });
  });

  describe("error handling", () => {
    it("throws the server-provided error message when JSON body has `error`", async () => {
      mockFetch({ error: "soul not found" }, 404);
      await expect(fetchSoulDetail("nope")).rejects.toThrow("soul not found");
    });

    it("falls back to status text when error body is non-JSON", async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("not json");
        },
      })) as unknown as typeof globalThis.fetch;
      await expect(fetchSouls()).rejects.toThrow("500 Internal Server Error");
    });
  });
});
