import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCS_ROOT = path.resolve("src/content/docs");
const LEGACY_IMAGE_BUDGET_BYTES = 512 * 1024;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g))(?:[?#][^)]*)?\)/gi;

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(filePath);
    }
  }

  return files;
}

describe("documentation image assets", () => {
  it("does not reference PNG or JPEG files larger than 512 KiB", async () => {
    const oversized: string[] = [];

    for (const markdownPath of await walkMarkdownFiles(DOCS_ROOT)) {
      const markdown = await readFile(markdownPath, "utf8");
      for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
        const imagePath = path.join(DOCS_ROOT, "images", path.basename(match[1]));
        const imageStat = await stat(imagePath);
        if (imageStat.size > LEGACY_IMAGE_BUDGET_BYTES) {
          oversized.push(`${path.relative(DOCS_ROOT, imagePath)} (${imageStat.size} bytes)`);
        }
      }
    }

    expect(oversized).toEqual([]);
  });
});
