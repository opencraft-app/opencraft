import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import subsetFont from "subset-font";

import {
  PRESERVED_TEXT,
  SPANISH_REQUIRED_CHARS,
  SPANISH_SOURCE_FONT_FALLBACK_CHARS,
  SPANISH_SOURCE_FONT_SUBSET_CHARS,
  classifySourceGlyphs,
  collectSubsetText,
  getSubsetTextInputs,
} from "./subset-fonts.mjs";

describe("subset fonts", () => {
  it("derives published dictionaries from the locale registry instead of a mirrored list", () => {
    const dictionaryFiles = getSubsetTextInputs("/frontend", [
      { i18nKey: "en-US", switcherVisible: true, translationRequired: true, fontSubsetEligible: true },
      { i18nKey: "zh-CN", switcherVisible: true, translationRequired: true, fontSubsetEligible: true },
      { i18nKey: "zh-CN", switcherVisible: true, translationRequired: true, fontSubsetEligible: true },
      { i18nKey: "es", switcherVisible: true, translationRequired: true, fontSubsetEligible: true },
      /* 模拟日语最终发布状态：即使入口已开放，也必须完全走系统字体。 */
      { i18nKey: "ja-JP", switcherVisible: true, translationRequired: true, fontSubsetEligible: false },
      { i18nKey: "ko-KR", switcherVisible: false, translationRequired: false, fontSubsetEligible: false },
    ])
      .filter((path) => path.includes("/src/i18n/generated/"))
      .map((path) => basename(path));

    expect(dictionaryFiles).toEqual(["en-US.json", "zh-CN.json", "es.json"]);
    expect(dictionaryFiles).not.toContain("ja-JP.json");
    expect(dictionaryFiles).not.toContain("ko-KR.json");
  });

  it("preserves common glyphs and forces the complete Spanish probe", () => {
    const root = mkdtempSync(join(tmpdir(), "subset-font-text-"));
    const fixture = join(root, "fixture.json");

    try {
      writeFileSync(fixture, "fixture único", "utf8");
      const text = collectSubsetText({ inputs: [fixture] });

      for (const char of "fixture único") expect(text).toContain(char);
      for (const char of PRESERVED_TEXT) expect(text).toContain(char);
      for (const char of SPANISH_REQUIRED_CHARS) expect(text).toContain(char);
      expect(SPANISH_SOURCE_FONT_SUBSET_CHARS + SPANISH_SOURCE_FONT_FALLBACK_CHARS).toBe(SPANISH_REQUIRED_CHARS);
      expect(SPANISH_SOURCE_FONT_SUBSET_CHARS).toBe("áéíóúüÁÉÍÓÚÜ");
      expect(SPANISH_SOURCE_FONT_FALLBACK_CHARS).toBe("ñÑ¿¡");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads all real published dictionaries and code inputs", () => {
    const inputs = getSubsetTextInputs(resolve("."));
    const filesRead = new Set<string>();
    const text = collectSubsetText({
      inputs,
      readText(file: string) {
        filesRead.add(file);
        return readFileSync(file, "utf8");
      },
    });

    for (const locale of ["zh-CN", "en-US", "zh-Hant", "id-ID", "es"]) {
      expect([...filesRead].some((file) => file.endsWith(`/src/i18n/generated/${locale}.json`))).toBe(true);
    }
    expect([...filesRead].some((file) => file.includes("/src/imports/Frame2147230025/"))).toBe(true);
    expect([...filesRead].some((file) => file.endsWith("/src/pages/marketing/landing-page.tsx"))).toBe(true);
    for (const char of SPANISH_REQUIRED_CHARS) expect(text).toContain(char);
  });

  it("distinguishes source-font gaps from glyphs retained by the subset", async () => {
    const source = readFileSync(resolve("assets/fonts/HYRuiYiSong-45J.ttf"));
    expect(classifySourceGlyphs(source)).toEqual({
      supported: "áéíóúüÁÉÍÓÚÜ",
      missing: "ñÑ¿¡",
    });

    const sfntSubset = await subsetFont(source, SPANISH_SOURCE_FONT_SUBSET_CHARS, { targetFormat: "sfnt" });
    expect(classifySourceGlyphs(sfntSubset, SPANISH_SOURCE_FONT_SUBSET_CHARS)).toEqual({
      supported: SPANISH_SOURCE_FONT_SUBSET_CHARS,
      missing: "",
    });
  });

  it("can be imported without generating a font artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "subset-font-import-"));
    const marker = join(root, "public", "fonts", "HYRuiYiSong-45J.subset.woff2");

    try {
      execFileSync(process.execPath, ["--input-type=module", "--eval", `import(${JSON.stringify(resolve("scripts/subset-fonts.mjs"))})`], {
        cwd: root,
        stdio: "pipe",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the CLI write path executable in an isolated frontend root", () => {
    const root = mkdtempSync(join(tmpdir(), "subset-font-cli-"));
    const fontDir = join(root, "assets", "fonts");
    const i18nDir = join(root, "src", "i18n");
    const output = join(root, "public", "fonts", "HYRuiYiSong-45J.subset.woff2");

    try {
      mkdirSync(fontDir, { recursive: true });
      mkdirSync(i18nDir, { recursive: true });
      copyFileSync(resolve("assets/fonts/HYRuiYiSong-45J.ttf"), join(fontDir, "HYRuiYiSong-45J.ttf"));
      copyFileSync(resolve("src/i18n/locales.json"), join(i18nDir, "locales.json"));
      const stdout = execFileSync(process.execPath, [resolve("scripts/subset-fonts.mjs")], {
        cwd: root,
        encoding: "utf8",
      });

      expect(statSync(output).size).toBeGreaterThan(0);
      expect(stdout).toContain("Spanish source-font supported: áéíóúüÁÉÍÓÚÜ");
      expect(stdout).toContain("source-font missing (system fallback): ñÑ¿¡");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes the Latin system stack to Spanish without changing the default Chinese stack", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");

    expect(css).toMatch(/html\[lang=["']es["']\]\s*\{[^}]*--font-heading:\s*var\(--font-latin\)/s);
    expect(css).toMatch(/html\[lang=["']es["']\]\s*\{[^}]*--font-body:\s*var\(--font-latin\)/s);
    expect(css).toMatch(/--font-latin:\s*-apple-system,\s*BlinkMacSystemFont,\s*["']Segoe UI["']/s);
    expect(css).toMatch(/:root\s*\{[\s\S]*?\}\s*\n\s*@theme\s*\{[\s\S]*?--font-heading:\s*[\s\S]*?["']PingFang SC["']/);
    expect(css).toMatch(/@theme\s*\{[\s\S]*?--font-body:\s*[\s\S]*?["']PingFang SC["']/);
    for (const selector of ["p", "label", "input", "textarea", "button", "span"]) {
      expect(css).toContain(`html[lang="es"] .landing-page ${selector}`);
    }
    expect(css).toMatch(/html\[lang=["']es["']\] \.landing-page span\s*\{\s*font-family:\s*var\(--font-body\)/);
  });

  it("uses a Japanese system stack without adding a Japanese webfont", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");

    expect(css).toMatch(
      /--font-japanese:\s*-apple-system,\s*BlinkMacSystemFont,\s*["']Hiragino Sans["'],\s*["']Yu Gothic["'],\s*["']YuGothic["'],\s*["']Noto Sans JP["'],\s*system-ui,\s*sans-serif/s,
    );
    expect(css).toMatch(/html\[lang=["']ja-JP["']\]\s*\{[^}]*--font-heading:\s*var\(--font-japanese\)/s);
    expect(css).toMatch(/html\[lang=["']ja-JP["']\]\s*\{[^}]*--font-body:\s*var\(--font-japanese\)/s);
    for (const selector of ["p", "label", "input", "textarea", "button", "span"]) {
      expect(css).toContain(`html[lang="ja-JP"] .landing-page ${selector}`);
    }
    expect(css).not.toMatch(/@font-face\s*\{[^}]*font-family:\s*["'][^"']*(?:Japanese|Noto Sans JP|Yu Gothic|Hiragino Sans)/si);
  });

  it("uses a Korean system stack without adding a Korean webfont", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");

    expect(css).toMatch(
      /--font-korean:\s*-apple-system,\s*BlinkMacSystemFont,\s*["']Apple SD Gothic Neo["'],\s*["']Malgun Gothic["'],\s*["']Noto Sans KR["'],\s*system-ui,\s*sans-serif/s,
    );
    expect(css).toMatch(/html\[lang=["']ko-KR["']\]\s*\{[^}]*--font-heading:\s*var\(--font-korean\)/s);
    expect(css).toMatch(/html\[lang=["']ko-KR["']\]\s*\{[^}]*--font-body:\s*var\(--font-korean\)/s);
    for (const selector of ["p", "label", "input", "textarea", "button", "span"]) {
      expect(css).toContain(`html[lang="ko-KR"] .landing-page ${selector}`);
    }
    expect(css).not.toMatch(/@font-face\s*\{[^}]*font-family:\s*["'][^"']*(?:Korean|Noto Sans KR|Malgun Gothic|Apple SD Gothic Neo)/si);
  });
});
