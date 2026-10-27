import type { AppServerClientRegistryService } from "@opencraft/appserver-client";
import type { AppServerBotDirectory } from "@opencraft/bot-conversation-appserver";
import type { ManagedBuiltinExtension, TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import type { ClientPersistenceScope } from "@opencraft/workbench-runtime";
import type { ClientBotManagementPolicy } from "./bot-management-policy";
export { resolveBotManagementPolicy } from "./bot-management-policy";
export type { ClientBotManagementPolicy, BotManagementMessages, ResolvedBotManagementPolicy } from "./bot-management-policy";

export interface ClientProductContext {
  readonly platform: "web" | "electron";
  readonly hostProfileMode?: "environment" | "configured";
  /** Resolved deployment defaults; persisted extension-manager choices still win. */
  readonly defaultExtensions?: readonly string[];
}

export interface ClientProductExtensionContext {
  readonly appServerClients: AppServerClientRegistryService;
  readonly profileSkills: AppServerProfileSkillsService;
  readonly profileDirectory: AppServerBotDirectory;
}

/** Borrowed capabilities; the application releases consumers before this owner. */
export interface ClientProductSession {
  /** Omit to use the application's account-scoped local persistence owner. */
  readonly persistenceScope?: ClientPersistenceScope;
  /** Product eligibility and copy; Host capabilities still gate every operation. */
  readonly botManagement?: ClientBotManagementPolicy;
  extensions(context: ClientProductExtensionContext): readonly TrustedExtensionDefinition[];
  /** Runs after extensions activate and before configured Host discovery. */
  preflight?(): Promise<void>;
  readonly builtins?: readonly ManagedBuiltinExtension[];
  dispose(): void | Promise<void>;
}

/** Trusted build/application assembly, never a module name supplied by HTTP or a plugin setting. */
export interface ClientWorkbenchProduct {
  /** Consume one-time login callbacks before Cordis or IndexedDB startup. */
  bootstrap?(context: ClientProductContext): void | Promise<void>;
  create(context: ClientProductContext): Promise<ClientProductSession>;
}
