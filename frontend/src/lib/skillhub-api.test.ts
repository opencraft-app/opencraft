/**
 * skillhub-api 单元测试
 *
 * 仅测可纯函数验证的部分：URL 拼接、参数序列化、错误处理。
 * 不测真实网络请求 —— 跨域、CORS、SkillHub 后端可用性归集成测试 / 手测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSkillFile,
  fetchSkillDetail,
  fetchSkillFiles,
  fetchSkillSetDetail,
  fetchSkillSets,
  fetchSoulDetail,
  fetchSouls,
  resolveSkillHubApiBase,
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
    vi.unstubAllEnvs();
  });

  describe("resolveSkillHubApiBase", () => {
    it("uses the local SkillHub proxy in dev", () => {
      expect(resolveSkillHubApiBase({ DEV: true })).toBe("/__skillhub_api");
    });

    it("uses the official SkillHub API outside dev", () => {
      expect(resolveSkillHubApiBase({ DEV: false })).toBe("https://api.skillhub.cn");
    });

    it("treats Next development mode as local dev when Vite env is unavailable", () => {
      vi.stubEnv("NODE_ENV", "development");
      expect(resolveSkillHubApiBase(undefined)).toBe("/__skillhub_api");
    });
  });

  describe("fetchSouls", () => {
    let fetchMock: typeof globalThis.fetch;
    beforeEach(() => {
      fetchMock = mockFetch({ souls: [] });
    });

    it("uses the SkillHub public souls endpoint", async () => {
      await fetchSouls();
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/souls");
    });

    it("appends paging query parameters", async () => {
      await fetchSouls({ page: 2, pageSize: 30 });
      expect(fetchMock).toHaveBeenCalledWith(
        "/__skillhub_api/api/v1/souls?page=2&pageSize=30",
      );
    });

    it("reuses the same successful list request", async () => {
      await fetchSouls({ page: 3, pageSize: 30 });
      await fetchSouls({ page: 3, pageSize: 30 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchSoulDetail", () => {
    it("URL-encodes the slug", async () => {
      const fetchMock = mockFetch({ slug: "a b" });
      await fetchSoulDetail("a b");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/souls/a%20b");
    });
  });

  describe("fetchSkillSets", () => {
    it("uses the SkillHub public skillsets endpoint", async () => {
      const fetchMock = mockFetch({ skillSets: [] });
      await fetchSkillSets();
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/skillsets");
    });

    it("appends scene, keyword and paging query parameters", async () => {
      const fetchMock = mockFetch({ skillSets: [] });
      await fetchSkillSets({ scene: "finance", keyword: " report ", page: 2, pageSize: 6 });
      expect(fetchMock).toHaveBeenCalledWith(
        "/__skillhub_api/api/v1/skillsets?keyword=report&scene=finance&page=2&pageSize=6",
      );
    });

    it("allows newly-added SkillHub scenes without frontend type changes", async () => {
      const fetchMock = mockFetch({ skillSets: [] });
      await fetchSkillSets({ scene: "mysticism" });
      expect(fetchMock).toHaveBeenCalledWith(
        "/__skillhub_api/api/v1/skillsets?scene=mysticism",
      );
    });
  });

  describe("fetchSkillSetDetail", () => {
    it("URL-encodes the slug", async () => {
      const fetchMock = mockFetch({ slug: "finance pack", skillSlugs: [] });
      await fetchSkillSetDetail("finance pack");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/skillsets/finance%20pack");
    });
  });

  describe("fetchSkillDetail", () => {
    it("URL-encodes the slug and unwraps the skill payload", async () => {
      const fetchMock = mockFetch({ skill: { slug: "qa plan", displayName: "QA Test Plan Generator" } });
      await expect(fetchSkillDetail("qa plan")).resolves.toEqual({
        slug: "qa plan",
        displayName: "QA Test Plan Generator",
      });
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/skills/qa%20plan");
    });
  });

  describe("fetchSkillFiles", () => {
    it("uses the SkillHub public skill files endpoint", async () => {
      const fetchMock = mockFetch({ files: [{ path: "SKILL.md", size: 1, sha256: "abc" }] });
      await expect(fetchSkillFiles("tdd guide")).resolves.toEqual([{ path: "SKILL.md", size: 1, sha256: "abc" }]);
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/skills/tdd%20guide/files");
    });
  });

  describe("fetchSkillFile", () => {
    it("URL-encodes the slug and path", async () => {
      const fetchMock = mockFetch("# Skill");
      await fetchSkillFile("tdd guide", "docs/SKILL.md");
      expect(fetchMock).toHaveBeenCalledWith("/__skillhub_api/api/v1/skills/tdd%20guide/file?path=docs%2FSKILL.md");
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
      await expect(fetchSoulDetail("broken-json")).rejects.toThrow("500 Internal Server Error");
    });
  });
});
