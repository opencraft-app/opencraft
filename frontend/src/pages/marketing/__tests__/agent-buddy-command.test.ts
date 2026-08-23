import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { BotRepository } from "@/repositories/types";

import {
  HERMES_PERSONA_COMMAND_TIMEOUT_MS,
  HERMES_PERSONA_COMMAND_MAX_BYTES,
  buildHermesSoulClearCommand,
  buildHermesSoulContentReadCommand,
  buildHermesSoulReadCommand,
  buildHermesSoulWriteCommand,
  executeHermesPersonaCommand,
  parseHermesSoulContent,
  parseHermesSoulIdentity,
} from "../agent-buddy-command";
import {
  PERSONA_MARKDOWN_MAX_BYTES,
  buildCustomSoulMarkdown,
  encodeUtf8Base64,
  validateCustomSoulMarkdown,
} from "../agent-persona-upload";

const execFileAsync = promisify(execFile);

describe("Hermes persona commands", () => {
  it.each([
    ["write", buildHermesSoulWriteCommand("c291bA==", "2026-07-23_01-02-03-000")],
    ["clear", buildHermesSoulClearCommand("2026-07-23_01-02-03-000")],
    ["read", buildHermesSoulReadCommand()],
  ])("derives the %s command paths from HERMES_HOME with a default fallback", (_kind, command) => {
    expect(command).toContain('HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"');
    expect(command).toContain('TARGET="$HERMES_ROOT/SOUL.md"');
    expect(command).not.toContain('WORKSPACE_DIR="${HOME}/.hermes"');
    expect(command).not.toContain('TARGET="${HOME}/.hermes/SOUL.md"');
  });

  it("bounds debug execution and accepts only successful status plus exit code", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({
      status: "Succeeded",
      exitCode: 0,
      output: "ok",
    });
    const bots = { execDebugCommand } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(
      executeHermesPersonaCommand(bots, "agent-a", "printf ok"),
    ).resolves.toMatchObject({ output: "ok" });
    expect(execDebugCommand).toHaveBeenCalledWith(
      "agent-a",
      "printf ok",
      { timeoutMs: HERMES_PERSONA_COMMAND_TIMEOUT_MS },
    );
    expect(HERMES_PERSONA_COMMAND_TIMEOUT_MS).toBe(120_000);
  });

  it("writes through a temporary file before atomically replacing SOUL.md", () => {
    const command = buildHermesSoulWriteCommand(
      "c291bA==",
      "2026-07-23_01-02-03-000",
    );

    expect(command).toContain('TEMP="$(mktemp "$HERMES_ROOT/.SOUL.md.tmp.XXXXXX")"');
    expect(command).toContain("trap 'rm -f \"$TEMP\"' EXIT");
    expect(command).toContain('base64 -d > "$TEMP"');
    expect(command).toContain('test -s "$TEMP"');
    expect(command).toContain('mv "$TEMP" "$TARGET"');
    expect(command).toContain("trap - EXIT");
    expect(command).not.toContain('base64 -d > "$TARGET"');
  });

  it("backs up the old Soul and preserves it when decoding fails", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "lightvela-persona-"));
    const soulPath = join(hermesHome, "SOUL.md");
    await writeFile(soulPath, "old soul\n", "utf8");

    try {
      const command = buildHermesSoulWriteCommand(
        "not-valid-base64!!!",
        "2026-07-23_01-02-03-000",
      );
      await expect(execFileAsync("/bin/bash", ["-c", command], {
        env: { ...process.env, HERMES_HOME: hermesHome },
      })).rejects.toThrow();

      await expect(readFile(soulPath, "utf8")).resolves.toBe("old soul\n");
      await expect(readFile(
        join(hermesHome, ".soul-backups", "2026-07-23_01-02-03-000.md"),
        "utf8",
      )).resolves.toBe("old soul\n");
      expect((await readdir(hermesHome)).some((name) => name.startsWith(".SOUL.md.tmp.")))
        .toBe(false);
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("keeps a normalized 20 KB custom persona below the sandbox command limit", () => {
    const wrapperBytes = new TextEncoder().encode(
      buildCustomSoulMarkdown("", "boundary.md").markdown,
    ).byteLength;
    const validation = validateCustomSoulMarkdown(
      "a".repeat(PERSONA_MARKDOWN_MAX_BYTES - wrapperBytes),
      "boundary.md",
    );
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    const command = buildHermesSoulWriteCommand(
      encodeUtf8Base64(validation.markdown),
      "2026-07-23_01-02-03-000",
    );

    expect(validation.byteLength).toBe(PERSONA_MARKDOWN_MAX_BYTES);
    expect(new TextEncoder().encode(command).byteLength).toBeLessThan(32 * 1024);
  });

  it("keeps a normalized 20 KB persona with a long Name below the command limit", () => {
    const name = "n".repeat(80);
    const source = (content: string) => [
      "# Soul",
      `Name: ${name}`,
      "",
      "## Content",
      content,
    ].join("\n");
    const baseBytes = new TextEncoder().encode(
      buildCustomSoulMarkdown(source(""), "boundary.md").markdown,
    ).byteLength;
    const validation = validateCustomSoulMarkdown(
      source("a".repeat(PERSONA_MARKDOWN_MAX_BYTES - baseBytes - 1)),
      "boundary.md",
    );
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    const command = buildHermesSoulWriteCommand(
      encodeUtf8Base64(validation.markdown),
      "2026-07-23_01-02-03-000",
    );

    expect(validation.byteLength).toBe(PERSONA_MARKDOWN_MAX_BYTES);
    expect(new TextEncoder().encode(command).byteLength)
      .toBeLessThan(HERMES_PERSONA_COMMAND_MAX_BYTES);
  });

  it("rejects a write command that exceeds the sandbox command limit", () => {
    expect(() => buildHermesSoulWriteCommand(
      "a".repeat(HERMES_PERSONA_COMMAND_MAX_BYTES),
      "2026-07-23_01-02-03-000",
    )).toThrow("exceeds the 32 KB limit");
  });

  it("reads only SOUL.md existence, slug, and name", () => {
    const command = buildHermesSoulReadCommand();

    expect(command).toContain("Exists: yes");
    expect(command).toContain("Exists: no");
    expect(command).toContain('grep -m1 "^Slug:" "$TARGET"');
    expect(command).toContain('grep -m1 "^Name:" "$TARGET"');
    expect(command).not.toContain('cat "$TARGET"');
    expect(command).not.toContain("ContentBase64:");
  });

  it("reads the current Soul through a bounded single-line Base64 protocol", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "lightvela-persona-read-"));
    const markdown = "# Soul\nName: 冷静的项目搭档\n\n## Identity\n先给结论。\n";
    await writeFile(join(hermesHome, "SOUL.md"), markdown, "utf8");

    try {
      const command = buildHermesSoulContentReadCommand();
      expect(command).toContain('BYTE_LENGTH="$(wc -c < "$TARGET"');
      expect(command).toContain("TooLarge: yes");
      expect(command).toContain("ContentBase64:");
      expect(command).not.toContain('cat "$TARGET"');

      const { stdout } = await execFileAsync("/bin/bash", ["-c", command], {
        env: { ...process.env, HERMES_HOME: hermesHome },
      });
      expect(parseHermesSoulContent(stdout)).toEqual({
        status: "ready",
        markdown,
        byteLength: new TextEncoder().encode(markdown).byteLength,
      });
      expect(stdout.match(/^ContentBase64:/gm)).toHaveLength(1);
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("writes and reads back a normalized Soul at the final 20 KB boundary", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "lightvela-persona-roundtrip-"));
    const wrapperBytes = new TextEncoder().encode(
      buildCustomSoulMarkdown("", "boundary.md").markdown,
    ).byteLength;
    const validation = validateCustomSoulMarkdown(
      "a".repeat(PERSONA_MARKDOWN_MAX_BYTES - wrapperBytes),
      "boundary.md",
    );
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    try {
      await execFileAsync("/bin/bash", ["-c", buildHermesSoulWriteCommand(
        encodeUtf8Base64(validation.markdown),
        "2026-07-23_01-02-03-000",
      )], {
        env: { ...process.env, HERMES_HOME: hermesHome },
      });
      const { stdout } = await execFileAsync(
        "/bin/bash",
        ["-c", buildHermesSoulContentReadCommand()],
        { env: { ...process.env, HERMES_HOME: hermesHome } },
      );

      expect(parseHermesSoulContent(stdout)).toEqual({
        status: "ready",
        markdown: validation.markdown,
        byteLength: PERSONA_MARKDOWN_MAX_BYTES,
      });
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("reports missing and oversized Soul files without returning content", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "lightvela-persona-read-state-"));

    try {
      const command = buildHermesSoulContentReadCommand();
      const missing = await execFileAsync("/bin/bash", ["-c", command], {
        env: { ...process.env, HERMES_HOME: hermesHome },
      });
      expect(missing.stdout.trim()).toBe("Exists: no");
      expect(parseHermesSoulContent(missing.stdout)).toEqual({ status: "missing" });

      await writeFile(join(hermesHome, "SOUL.md"), "a".repeat((20 * 1024) + 1), "utf8");
      const oversized = await execFileAsync("/bin/bash", ["-c", command], {
        env: { ...process.env, HERMES_HOME: hermesHome },
      });
      expect(oversized.stdout).not.toContain("ContentBase64:");
      expect(parseHermesSoulContent(oversized.stdout)).toEqual({
        status: "too_large",
        byteLength: (20 * 1024) + 1,
      });
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("strictly parses valid Soul content and rejects malformed payloads", () => {
    const markdown = "# Soul\nName: 测试人设\n";
    const byteLength = new TextEncoder().encode(markdown).byteLength;
    expect(parseHermesSoulContent([
      "Exists: yes",
      `ByteLength: ${byteLength}`,
      `ContentBase64: ${encodeUtf8Base64(markdown)}`,
    ].join("\n"))).toEqual({ status: "ready", markdown, byteLength });

    expect(parseHermesSoulContent("Exists: no\n")).toEqual({ status: "missing" });
    expect(parseHermesSoulContent([
      "Exists: yes",
      "TooLarge: yes",
      "ByteLength: 20481",
    ].join("\n"))).toEqual({ status: "too_large", byteLength: 20481 });

    for (const output of [
      "unexpected output",
      "Exists: yes\nByteLength: -1\nContentBase64: YQ==",
      "Exists: yes\nByteLength: 1\nContentBase64: !!!",
      "Exists: yes\nByteLength: 1\nContentBase64: /w==",
      "Exists: yes\nByteLength: 2\nContentBase64: YQ==",
      `Exists: yes\nByteLength: ${(20 * 1024) + 1}\nContentBase64: YQ==`,
      "Exists: yes\nTooLarge: yes\nByteLength: nope",
    ]) {
      expect(parseHermesSoulContent(output)).toEqual({ status: "invalid" });
    }
  });

  it("parses custom Soul identity without exposing Markdown content", () => {
    expect(parseHermesSoulIdentity([
      "Exists: yes",
      "Slug: custom-upload",
      "Name: 冷静的项目搭档",
    ].join("\n"))).toEqual({
      exists: true,
      slug: "custom-upload",
      name: "冷静的项目搭档",
    });
    expect(parseHermesSoulIdentity("Exists: no\n")).toEqual({
      exists: false,
      slug: null,
      name: null,
    });
    expect(parseHermesSoulIdentity("unexpected output")).toEqual({
      exists: false,
      slug: null,
      name: null,
    });
  });

  it.each([
    { status: "TIMEOUT", exitCode: 0 },
    { status: "FAILED", exitCode: 0 },
    { status: "SUCCESS", exitCode: 1 },
  ])("rejects a non-success command result: %o", async ({ status, exitCode }) => {
    const bots = {
      execDebugCommand: vi.fn().mockResolvedValue({
        status,
        exitCode,
        output: "persona command failed",
      }),
    } as Pick<BotRepository, "execDebugCommand"> as BotRepository;

    await expect(
      executeHermesPersonaCommand(bots, "agent-a", "printf ok"),
    ).rejects.toThrow("persona command failed");
  });
});
