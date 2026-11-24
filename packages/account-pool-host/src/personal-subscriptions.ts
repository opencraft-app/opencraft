// A Human's personal Codex subscription as the model gateway's settings route
// sees it (runtime-neutral). The route asks to start, poll or cancel; a
// completed subscription is a connection (a provider route and a pool token)
// that the gateway's contributions record as the Human's personal key.
//
// Two implementations, one interface:
//   Node         the Codex Core over its control socket (`CodexCoreControlClient`),
//                which owns the Human's personal pool, its device login and the
//                loopback subscription proxy (codexCorePersonalSubscriptions)
//   AccountCore  the account pool in the same object (accountPoolPersonalSubscriptions):
//                the Human's accounts are the pool's rows owned by that Human
//                (`ownerActor`), the token is that pool's Host token
import { createHash } from "node:crypto";
import type { AccountPool } from "./account-pool.js";
import { ModelGatewayError } from "./model-gateway.js";

export type PersonalSubscriptionOperation = "start" | "poll" | "cancel";

export interface PersonalSubscriptionConnection {
  providerId: string;
  baseUrl: string;
  proxyToken: string;
  models: { id: string; name?: string; enabled: boolean }[];
  name?: string;
  accounts?: { label: unknown; subscriptionType: unknown; enabled: boolean }[];
}

/** `complete` carries the connection; anything else is answered to the Human as it is. */
export type PersonalSubscriptionReply =
  { status: "complete"; connection: PersonalSubscriptionConnection } | ({ status?: string } & Record<string, unknown>);

export interface PersonalSubscriptions {
  request(
    actor: string,
    operation: PersonalSubscriptionOperation,
    sessionId: unknown,
  ): Promise<PersonalSubscriptionReply>;
  /**
   * Checks a completed connection against where this implementation serves
   * subscriptions (Node: the Codex Core's loopback proxy); throws
   * `invalid_subscription_connection` otherwise.
   */
  accept(actor: string, connection: unknown): PersonalSubscriptionConnection;
}

/** The Human's namespace: providers, tokens and routes never carry the Actor id itself. */
export const personalSubscriptionNamespace = (actor: string) => createHash("sha256").update(actor).digest("hex");

const invalidConnection = () => new ModelGatewayError("invalid_subscription_connection", 503);

/** The Codex Core's control requests (CodexCoreControlClient on Node). */
export interface PersonalSubscriptionControl {
  accountRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Node: the Codex Core owns personal pools and their loopback proxy. */
export function codexCorePersonalSubscriptions(control: PersonalSubscriptionControl): PersonalSubscriptions {
  return {
    async request(actor, operation, sessionId) {
      return (await control.accountRequest("opencraft/codex/accounts/personal/" + operation, {
        actor,
        sessionId,
      })) as PersonalSubscriptionReply;
    },
    accept(actor, descriptor) {
      const value = descriptor as PersonalSubscriptionConnection;
      const namespace = personalSubscriptionNamespace(actor);
      let url: URL;
      try {
        url = new URL(value.baseUrl);
      } catch {
        throw invalidConnection();
      }
      // Only the Core's own loopback proxy serves a Human's subscription.
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/personal/" + namespace + "/v1")
        throw invalidConnection();
      return value;
    },
  };
}

/** The subscription route a deployment serves for a Human's pool, when it has one. */
export interface PersonalSubscriptionRoute {
  /** The provider base URL for the Human's namespace. */
  baseUrl(namespace: string): string;
  /** The models the Human's subscription offers, read through the route with the pool token. */
  models(namespace: string, token: string): Promise<PersonalSubscriptionConnection["models"]>;
}

/**
 * AccountCore: the account pool in the same object. A Human's subscription is
 * complete when the pool holds an enabled account owned by that Human; the
 * connection's token is a Host token of the Human's pool. Device login and the
 * subscription route are the maintenance executor's and the Codex selection
 * egress's (cloudflare-deployment §5.6 "仍缺"): without a login a Human without
 * accounts cannot start one, and without a route a completed subscription has
 * nowhere to send requests; both answer as unavailable rather than pretending.
 */
export function accountPoolPersonalSubscriptions(options: {
  /** The pool of one Human's accounts (`ownerActor`) over the object's pool storage. */
  pool(actor: string): AccountPool;
  route?: PersonalSubscriptionRoute | null;
}): PersonalSubscriptions {
  return {
    async request(actor, operation) {
      // No login sessions exist in this owner, so there is nothing to cancel.
      if (operation === "cancel") return { cancelled: false };
      const namespace = personalSubscriptionNamespace(actor);
      const pool = options.pool(actor);
      const accounts = pool.listAccounts().filter((account) => account.enabled);
      if (!accounts.length) throw new Error("Personal subscription login is unavailable");
      const route = options.route;
      if (!route) throw new Error("Personal subscription route is unavailable");
      const token = pool.issueHostToken("personal-subscription:" + namespace);
      const models = await route.models(namespace, token);
      if (!models.length) throw new Error("Subscription has no available models");
      return {
        status: "complete",
        connection: {
          providerId: "subscription-" + namespace,
          baseUrl: route.baseUrl(namespace),
          proxyToken: token,
          models,
          name: "我的 Codex 订阅",
          accounts: accounts.map((account) => ({
            label: account.label,
            subscriptionType: null,
            enabled: account.enabled,
          })),
        },
      };
    },
    accept(actor, descriptor) {
      const value = descriptor as PersonalSubscriptionConnection;
      const namespace = personalSubscriptionNamespace(actor);
      let url: URL;
      try {
        url = new URL(value.baseUrl);
      } catch {
        throw invalidConnection();
      }
      if (!options.route || url.toString() !== new URL(options.route.baseUrl(namespace)).toString())
        throw invalidConnection();
      return value;
    },
  };
}
