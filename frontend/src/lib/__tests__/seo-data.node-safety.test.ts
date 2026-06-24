/**
 * 守护测试：保证 Node 侧构建/校验脚本复用的 SEO 模块
 * （seo-data.ts / seo-html.ts）始终可在 Node 加载阶段安全解析。
 *
 * 背景：这些模块会被 release/check 脚本直接 import，此时既没有 `@/` 路径
 * alias，也没有浏览器侧 `import.meta.env`。如果这些模块引入了这两类依赖，
 * 脚本会直接启动失败（ERR_MODULE_NOT_FOUND）。
 * 该测试把这一约束固化进 CI，任何破坏性改动都会让测试失败，避免未来迭代踩坑。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 测试从 frontend 根目录运行（package.json 所在处），直接按工程相对路径读取源码，
// 避免依赖 import.meta.url（在该测试环境下不保证为 file: scheme）。
const FILES_UNDER_GUARD = [
  { name: "seo-data.ts", relPath: "src/lib/seo-data.ts" },
  { name: "seo-html.ts", relPath: "src/lib/seo-html.ts" },
] as const;

/**
 * 剥离注释（块注释 + 行注释），仅保留可执行代码用于守护检测。
 * 否则"说明性注释里提到的 import.meta / @/"会被误判为真实代码依赖。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释 /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // 行注释 //...（用 [^:] 避免误伤 http://）
}

function loadSource(relPath: string): string {
  const abs = path.resolve(process.cwd(), relPath);
  return stripComments(readFileSync(abs, "utf8"));
}

describe("SEO modules consumed by node scripts must stay node-loadable", () => {
  for (const { name, relPath } of FILES_UNDER_GUARD) {
    describe(name, () => {
      const source = loadSource(relPath);

      it("does not import via the `@/` path alias", () => {
        // `@/` alias 仅在 bundler/tsconfig paths 解析时生效，Node 直接加载脚本时不可用。
        const aliasImport = /\bfrom\s+["']@\//;
        expect(aliasImport.test(source)).toBe(false);
      });

      it("does not rely on import.meta in executable code", () => {
        // Node 侧没有浏览器构建环境，region 必须由参数显式传入。
        expect(source.includes("import.meta")).toBe(false);
      });

      it("only imports node-resolvable relative/bare modules", () => {
        const importPaths = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
          .map((m) => m[1])
          .filter((p): p is string => typeof p === "string");
        for (const importPath of importPaths) {
          const isRelative = importPath.startsWith("./") || importPath.startsWith("../");
          const isBare = !importPath.startsWith("@/") && !importPath.startsWith("/");
          expect(isRelative || isBare).toBe(true);
        }
      });
    });
  }

  it("exposes a region-aware getSeoMeta importable without vite alias", async () => {
    // 通过相对路径 import（不经过 `@/` alias），模拟 node 解析上下文。
    const mod = await import("../seo-data");
    expect(typeof mod.getSeoMeta).toBe("function");
    expect(mod.getSeoMeta("/about", "cn").title).toContain("关于我们");
    expect(mod.getSeoMeta("/about", "global").title).toContain("About LightVela");
  });

  it("does not throw for malformed encoded Agent route segments", async () => {
    const mod = await import("../seo-data");

    expect(() => mod.getSeoMeta("/agents/%E4%B8", "cn")).not.toThrow();
    expect(() => mod.getSeoMeta("/agents/%ZZ", "cn")).not.toThrow();
    expect(mod.getSeoMeta("/agents/%ZZ", "cn").title).toContain("Agent 控制台");
    expect(mod.getSeoMeta("/agents/%ZZ", "global").title).toContain("Agent Console");
  });

  it("exposes applySeoToHtml importable without vite alias", async () => {
    // seo-html.ts 也被 Node 脚本直接复用，必须在 node 上下文可加载。
    const mod = await import("../seo-html");
    expect(typeof mod.applySeoToHtml).toBe("function");
    const html = '<html><head><title>OLD</title></head><body></body></html>';
    const out = mod.applySeoToHtml(html, "/about", "global");
    expect(out).toContain("About LightVela");
  });
});
