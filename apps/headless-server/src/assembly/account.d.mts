import type { IncomingMessage } from "node:http";
import type { HttpExchangeHandler } from "@opencraft/http-exchange";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import type { SecretStore } from "@opencraft/secret-storage";
import type { ModelPolicyDatabase, ModelPolicyStore } from "@opencraft/model-usage-policy/store";
import type { ModelPolicyAuthority } from "@opencraft/model-usage-policy/http";
import type {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "@opencraft/local-agent-host/model-config/repository";
import type { CredentialLeases } from "@opencraft/account-pool-host/credential-leases";
import type { ModelGatewayStoreHolder } from "@opencraft/account-pool-host/model-gateway";
import type { PersonalSubscriptions } from "@opencraft/account-pool-host/personal-subscriptions";
import type { AccountAuthority, InstallationAuthorityServices } from "../account-routes.ts";

/** The Node gateway's installation services (kept as the account module's historical name). */
export type AccountHttpAuthorities = InstallationAuthorityServices<IncomingMessage>;

/** Who may use the account's routes for one request; the policy authority may answer asynchronously. */
export interface AccountRouteAuthorities<Request> {
  policy(request: Request): ModelPolicyAuthority | null | Promise<ModelPolicyAuthority | null>;
  gateway(request: Request): AccountAuthority | null | Promise<AccountAuthority | null>;
}

/** The account's storage and services as ports; each root passes its own adapters. */
export interface AccountInputs {
  /** Opens (and migrates) the policy database; called once, when the account is assembled. */
  openModelPolicy(): ModelPolicyDatabase;
  /** Model configuration (`models.json`) and the credential lease ledger. */
  modelDocuments: StateDocumentStore;
  /** Model credentials, by reference. */
  modelSecrets: SecretStore;
  /**
   * The model gateway's storage and personal subscriptions; read once, when the
   * first HTTP service is created. Absent or null when the deployment has none.
   */
  modelGateway?(): ModelGatewayInputs | null;
}

export interface ModelGatewayInputs {
  /** The gateway store; the account borrows it for its routes and closes it in `close`. */
  readonly store: ModelGatewayStoreHolder;
  /** Personal subscriptions; null when the deployment offers none. */
  readonly subscriptions: PersonalSubscriptions | null;
}

export interface AccountAssembly {
  /** The only writer of the model usage policy database. */
  readonly modelPolicy: ModelPolicyStore;
  readonly modelConfiguration: ModelConfigurationRepository;
  readonly modelCredentials: ModelCredentialRepository;
  /** Short-lived model credential leases over the model configuration and credentials. */
  readonly credentialLeases: CredentialLeases;
  /** Model gateway and model policy routes as an exchange handler; resolves null for any other path. */
  createAccountHttpService<Request>(authorities: AccountRouteAuthorities<Request>): HttpExchangeHandler<Request>;
  /** The same routes with authorities from the installation's services in this process (the Node gateway). */
  createHttpService(authorities: AccountHttpAuthorities): HttpExchangeHandler<IncomingMessage>;
  /** A new speech transcription service; the Web server closes it with itself. */
  createSpeechService(): { close(): void };
  /** Closes the gateway store (if one was opened), then the policy writer; the composition root calls it before releasing its writer lock. */
  close(): void;
}

export function assembleAccount(inputs: AccountInputs): AccountAssembly;
