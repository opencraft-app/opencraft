import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ShellCommandClassifierService,
  isSmallFormattingCommand,
  parseCommand,
  tokenizeShellWords,
} from "../apps/local-agent-host/src/hypernode/shell-command-classifier.js";

const fixtureUrl = new URL(
  "./fixtures/codex-shell-command-0.148.0-alpha.21.json",
  import.meta.url,
);
const upstream = JSON.parse(await readFile(fixtureUrl, "utf8"));

test("vendored corpus contains every upstream parse_command parser assertion", () => {
  assert.equal(upstream.source.revision, "fecac1c348af3634924e1a1b5413376208ee1884");
  assert.equal(upstream.upstreamTestCount, 81);
  assert.equal(upstream.parserCaseCount, 117);
  assert.equal(upstream.cases.length, 117);
  assert.equal(new Set(upstream.cases.map((entry) => entry.test)).size, 75);
});

for (const fixture of upstream.cases) {
  test(`Codex parse_command parity: ${fixture.test} ${JSON.stringify(fixture.argv)}`, () => {
    assert.deepEqual(parseCommand(fixture.argv), fixture.expected);
  });
}

// These six upstream tests exercise the formatting helper directly rather than
// going through assert_parsed. Keep the cases and assertions structurally equal
// to codex-shell-command's parse_command.rs tests.
test("Codex parity: small_formatting_always_true_commands", () => {
  for (const cmd of ["wc", "tr", "cut", "sort", "uniq", "xargs", "tee", "column"]) {
    assert.equal(isSmallFormattingCommand(tokenizeShellWords(cmd)), true);
    assert.equal(isSmallFormattingCommand(tokenizeShellWords(`${cmd} -x`)), true);
  }
});

test("Codex parity: awk_behavior", () => {
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("awk '{print $1}'")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("awk '{print $1}' Cargo.toml")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("awk -f script.awk Cargo.toml")), false);
});

test("Codex parity: head_behavior", () => {
  assert.equal(isSmallFormattingCommand(["head"]), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("head -n 40")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("head -n 40 file.txt")), false);
  assert.equal(isSmallFormattingCommand(["head", "file.txt"]), false);
});

test("Codex parity: tail_behavior", () => {
  assert.equal(isSmallFormattingCommand(["tail"]), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -n +10")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -n +10 file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -n 30")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -n 30 file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -c 30")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("tail -c +10")), true);
  assert.equal(isSmallFormattingCommand(["tail", "file.txt"]), false);
});

test("Codex parity: sed_behavior", () => {
  assert.equal(isSmallFormattingCommand(["sed"]), true);
  assert.equal(isSmallFormattingCommand(["sed", "-n", "10p"]), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n 10p file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n -e 10p file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n 10p -- file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n 1,200p file.txt")), false);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n p file.txt")), true);
  assert.equal(isSmallFormattingCommand(tokenizeShellWords("sed -n +10p file.txt")), true);
});

test("Codex parity: empty_tokens_is_not_small", () => {
  assert.equal(isSmallFormattingCommand([]), false);
});

test("Cordis service projects Codex ParsedCommand into native commandActions", () => {
  const service = Object.create(ShellCommandClassifierService.prototype);
  const actions = service.classify("cd src && rg -n 'needle' app | head -n 20", {
    cwd: "/workspace/projects/demo",
  });
  assert.deepEqual(actions, [{
    type: "search",
    command: "rg -n needle app",
    query: "needle",
    path: "app",
  }]);

  assert.deepEqual(service.classify("cat src/main.js", { cwd: "/workspace/projects/demo" }), [{
    type: "read",
    command: "cat src/main.js",
    name: "main.js",
    path: "/workspace/projects/demo/src/main.js",
  }]);
});

test("display-only echo between semantic commands does not collapse search and read to unknown", () => {
  const script = String.raw`grep -rn "duration.*100\|100.*year\|DurationUnit" /workspace/projects/mono2/velagw/internal/gateway/set_reconcile.go | head -10; echo ===; sed -n 530,560p /workspace/projects/mono2/velagw/internal/gateway/set_reconcile.go`;

  assert.deepEqual(parseCommand(["bash", "-lc", script]), [
    {
      type: "search",
      cmd: "grep -rn 'duration.*100|100.*year|DurationUnit' /workspace/projects/mono2/velagw/internal/gateway/set_reconcile.go",
      query: "duration.*100|100.*year|DurationUnit",
      path: "set_reconcile.go",
    },
    {
      type: "read",
      cmd: "sed -n '530,560p' /workspace/projects/mono2/velagw/internal/gateway/set_reconcile.go",
      name: "set_reconcile.go",
      path: "/workspace/projects/mono2/velagw/internal/gateway/set_reconcile.go",
    },
  ]);
});

test("multiline cd and display banner preserve the following file read", () => {
  const script = `cd /workspace/projects/mono2
echo "######## PROJECT_ANALYSIS.md ########"
cat PROJECT_ANALYSIS.md | head -200`;

  assert.deepEqual(parseCommand(["bash", "-lc", script]), [{
    type: "read",
    cmd: "cat PROJECT_ANALYSIS.md",
    name: "PROJECT_ANALYSIS.md",
    path: "/workspace/projects/mono2/PROJECT_ANALYSIS.md",
  }]);
});

test("stderr discard and inverse grep filters preserve the primary read and search actions", () => {
  const script = String.raw`sed -n 545,560p /workspace/projects/mono2/ctl/pkg/logic/bundle/logic.go; echo ===; grep -rn "credit_token_ratio" /workspace/projects/mono2 --include="*.toml" --include="*.yaml" --include="*.yml" --include="*.json" 2>/dev/null | grep -v node_modules | head -8`;

  assert.deepEqual(parseCommand(["bash", "-lc", script]), [
    {
      type: "read",
      cmd: "sed -n '545,560p' /workspace/projects/mono2/ctl/pkg/logic/bundle/logic.go",
      name: "logic.go",
      path: "/workspace/projects/mono2/ctl/pkg/logic/bundle/logic.go",
    },
    {
      type: "search",
      cmd: "grep -rn credit_token_ratio /workspace/projects/mono2 '--include=*.toml' '--include=*.yaml' '--include=*.yml' '--include=*.json'",
      query: "credit_token_ratio",
      path: "mono2",
    },
  ]);
});

test("a safe grep-derived sed range preserves search and targeted read actions", () => {
  const script = String.raw`grep -rn "BUNDLE_CREDIT_TOKEN_MISMATCH" ctl/pkg/errcode/bundle.go; echo "==="; grep -n "credit.*10000\|CreditTokenRatio" ctl/pkg/logic/bundle/logic.go | head; echo "==="; sed -n "$(grep -n 'BUNDLE_CREDIT_TOKEN_MISMATCH' ctl/pkg/logic/bundle/logic.go | head -1 | cut -d: -f1),-15p" ctl/pkg/logic/bundle/logic.go 2>/dev/null | head -30`;

  assert.deepEqual(
    parseCommand(["bash", "-lc", script]).map(({ type, query, path, name }) => ({
      type, query, path, name,
    })),
    [
      {
        type: "search",
        query: "BUNDLE_CREDIT_TOKEN_MISMATCH",
        path: "bundle.go",
        name: undefined,
      },
      {
        type: "search",
        query: "credit.*10000|CreditTokenRatio",
        path: "logic.go",
        name: undefined,
      },
      {
        type: "read",
        query: undefined,
        path: "ctl/pkg/logic/bundle/logic.go",
        name: "logic.go",
      },
    ],
  );
});

test("command substitution remains unknown outside the narrow read-only sed locator", () => {
  const unsafe = [
    String.raw`echo "$(grep -n needle file.go | head -1 | cut -d: -f1)"`,
    String.raw`sed -n "$(rm -rf tmp),+15p" file.go`,
    String.raw`sed -n "$(grep -n needle file.go | xargs rm),+15p" file.go`,
    String.raw`sed -n $(grep -n needle file.go | head -1 | cut -d: -f1),+15p file.go`,
  ];
  for (const script of unsafe) {
    assert.deepEqual(parseCommand(["bash", "-lc", script]), [{
      type: "unknown",
      cmd: script,
    }]);
  }
});
