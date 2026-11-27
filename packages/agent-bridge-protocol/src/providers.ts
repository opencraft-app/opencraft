/**
 * Agent providers and where each one's native agent comes from.
 *
 * An agent such as Codex can have more than one source. The builtin source is
 * the native agent OpenCraft packages at a pinned version; the external source
 * is one the user installed, whose version OpenCraft does not control. Both are
 * declared here, side by side, so the bundled Codex is one source of the Codex
 * provider rather than a separate kind of engine. Execution paths still differ
 * today: this catalog declares identity and origin, not routing.
 */

/** Pinned native Codex shipped in desktop packages (`runtime/codex`). */
export const BUILTIN_CODEX_VERSION = "0.167.2" as const;

export interface BuiltinAgentSource {
  readonly kind: "builtin";
  /** Packaged next to OpenCraft; never discovered on PATH. */
  readonly distribution: "bundled";
  readonly nativeVersion: string;
  /** Native protocol the current OpenCraft path speaks to it. */
  readonly protocol: "codex-app-server";
}

export interface ExternalAgentSource {
  readonly kind: "external";
  readonly distribution: "user-installed";
  /** Executable names looked up on the user's PATH, in order. */
  readonly commands: readonly string[];
  readonly versionArgs: readonly string[];
  readonly statusArgs: readonly string[];
  readonly signInArgs: readonly string[];
  readonly signInEnv: Readonly<Record<string, string>>;
  /** npm package OpenCraft may install for the user, or null when it must not. */
  readonly installPackage: string | null;
  readonly installUrl: string;
  readonly protocol: "acp";
}

export type AgentSource = BuiltinAgentSource | ExternalAgentSource;

export interface AgentProvider {
  /** Stable agent identity used by onboarding and thread routing. */
  readonly id: "codex" | "cursor" | "claude" | "codebuddy";
  /** Engine identity used by model/list and thread ids. */
  readonly engineId: string;
  readonly displayName: string;
  readonly sources: readonly AgentSource[];
}

export const AGENT_PROVIDERS = [
  {
    id: "codex",
    engineId: "codex",
    displayName: "Codex",
    sources: [
      { kind: "builtin", distribution: "bundled", nativeVersion: BUILTIN_CODEX_VERSION, protocol: "codex-app-server" },
      {
        kind: "external",
        distribution: "user-installed",
        protocol: "acp",
        commands: ["codex"],
        versionArgs: ["--version"],
        statusArgs: ["login", "status"],
        signInArgs: ["login"],
        signInEnv: { BROWSER: "/usr/bin/true" },
        installPackage: "@openai/codex",
        installUrl: "https://developers.openai.com/codex/cli",
      },
    ],
  },
  {
    id: "cursor",
    engineId: "cursor",
    displayName: "Cursor",
    sources: [
      {
        kind: "external",
        distribution: "user-installed",
        protocol: "acp",
        commands: ["cursor-agent"],
        versionArgs: ["--version"],
        statusArgs: ["status"],
        signInArgs: ["login"],
        signInEnv: { NO_OPEN_BROWSER: "1" },
        installPackage: null,
        installUrl: "https://cursor.com/docs/cli/installation",
      },
    ],
  },
  {
    id: "claude",
    engineId: "claude-code",
    displayName: "Claude Code",
    sources: [
      {
        kind: "external",
        distribution: "user-installed",
        protocol: "acp",
        commands: ["claude"],
        versionArgs: ["--version"],
        statusArgs: ["auth", "status"],
        signInArgs: ["auth", "login"],
        signInEnv: { BROWSER: "/usr/bin/true" },
        installPackage: null,
        installUrl: "https://code.claude.com/docs/en/setup",
      },
    ],
  },
  {
    id: "codebuddy",
    engineId: "codebuddy",
    displayName: "CodeBuddy",
    sources: [
      {
        kind: "external",
        distribution: "user-installed",
        protocol: "acp",
        commands: ["codebuddy", "cbc"],
        versionArgs: ["--version"],
        statusArgs: ["--version"],
        signInArgs: ["auth", "login"],
        signInEnv: {},
        installPackage: "@tencent-ai/codebuddy-code",
        installUrl: "https://www.codebuddy.cn/cli/",
      },
    ],
  },
] as const satisfies readonly AgentProvider[];

export type AgentProviderId = (typeof AGENT_PROVIDERS)[number]["id"];

export function builtinSource(provider: AgentProvider): BuiltinAgentSource | null {
  return provider.sources.find((source): source is BuiltinAgentSource => source.kind === "builtin") ?? null;
}

export function externalSource(provider: AgentProvider): ExternalAgentSource | null {
  return provider.sources.find((source): source is ExternalAgentSource => source.kind === "external") ?? null;
}
