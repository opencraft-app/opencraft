import { composerDocumentToPlainText, type SubmitIntent } from "@opencraft/composer-core";
import type { ContributionMessage } from "@opencraft/extension-contract";
import type { AgentRuntimeProtocolPort } from "./agent-runtime/contract";
import type { HostConnectionProvider, HostConnectionProviderContext, HostConnectionProviderLease } from "./host-connections";

/** Suggestions insert editable text. Only explicit submission may invoke an action. */
export interface HostComposerCommand {
  readonly name: string;
  readonly description: ContributionMessage;
  readonly kind: "prompt" | "action";
}

export interface HostComposerCommandTarget {
  readonly threadId: string | null;
  readonly expectedTurnId: string | null;
}

export interface HostComposerCommandContext extends HostConnectionProviderContext, HostComposerCommandTarget {
  /** Bound to the resident Host, never a lookup of the currently selected Host. */
  readonly protocol: AgentRuntimeProtocolPort;
}

export interface HostComposerCommands {
  readonly commands: readonly HostComposerCommand[];
  invoke?(name: string, context: HostComposerCommandContext): Promise<void>;
}

export interface HostComposerCommandPort {
  readonly commands: readonly HostComposerCommand[];
  invoke(name: string, target: HostComposerCommandTarget): Promise<void>;
}

/** Validate and copy declarations at the trusted extension registration boundary. */
export function normalizeHostComposerCommands(value: HostComposerCommands): HostComposerCommands {
  const names = new Set<string>();
  const commands = value.commands.map(command => {
    if (!/^[a-z][a-z0-9_-]*$/u.test(command.name) || names.has(command.name)) {
      throw new TypeError(`Invalid or duplicate Host Composer command: ${command.name}`);
    }
    names.add(command.name);
    if (command.kind !== "prompt" && command.kind !== "action") throw new TypeError("Invalid Host Composer command kind");
    if (command.kind === "action" && typeof value.invoke !== "function") throw new TypeError("Host Composer actions require an invoker");
    if (!command.description.id.trim() || !command.description.defaultMessage.trim()) {
      throw new TypeError("Host Composer commands require localized descriptions");
    }
    return Object.freeze({ name: command.name, kind: command.kind, description: Object.freeze({ ...command.description }) });
  });
  return Object.freeze({ commands: Object.freeze(commands), ...(value.invoke === undefined ? {} : { invoke: value.invoke }) });
}

/** Attachments, context, code blocks, arguments and ordinary prompts stay in submission. */
export function findStandaloneHostComposerAction(
  intent: SubmitIntent,
  commands: readonly HostComposerCommand[],
): HostComposerCommand | null {
  if (intent.attachments.length !== 0 || intent.context.length !== 0
    || intent.document.blocks.length !== 1 || intent.document.blocks[0]?.type !== "paragraph") return null;
  const text = composerDocumentToPlainText(intent.document).trim();
  return commands.find(command => command.kind === "action" && text === `/${command.name}`) ?? null;
}

/** A resident runtime's command port shares its provider owner, with per-call drain leases. */
export function createHostComposerCommandPort(input: {
  readonly provider: HostConnectionProvider;
  readonly context: HostConnectionProviderContext;
  readonly protocol: AgentRuntimeProtocolPort;
  readonly isCurrent: () => boolean;
  readonly acquire: () => HostConnectionProviderLease;
}): HostComposerCommandPort | undefined {
  const contribution = input.provider.composerCommands;
  if (contribution === undefined) return undefined;
  return {
    commands: contribution.commands,
    async invoke(name, target) {
      if (!input.isCurrent()) throw new Error("Host Composer command owner is no longer current");
      const lease = input.acquire();
      try {
        if (lease.provider !== input.provider) throw new Error("Host Composer command provider has changed");
        if (!contribution.commands.some(command => command.name === name && command.kind === "action") || !contribution.invoke) {
          throw new Error(`Host Composer action ${name} is unavailable`);
        }
        await contribution.invoke(name, {
          ...input.context, threadId: target.threadId, expectedTurnId: target.expectedTurnId, protocol: input.protocol,
        });
      } finally {
        lease.release();
      }
    },
  };
}
