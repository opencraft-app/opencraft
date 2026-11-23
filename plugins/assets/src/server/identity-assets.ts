import type { IncomingMessage, ServerResponse } from "node:http";
import {
  openActorAdmission,
  type LoginPrincipal,
  type OpenActorAdmissionOptions,
} from "@opencraft/access-control/actor-admission";
import type { WorkspaceActorAdmission } from "@opencraft/access-control/actor-admission-reader";
import { EnvironmentError } from "@opencraft/execution-environment/account-environment";
import { AccountEnvironmentHttp } from "@opencraft/execution-environment/account-environment-http";
import type { GitProviderDescriptor } from "../git/contract.js";
import type { AssetActorSettingsMethods, AssetEnvironmentSettingsMethods } from "./actor-settings.js";
import type { OwnerCalls } from "@opencraft/worker-owner";
import { SandboxConfigurationError } from "./errors.js";
import { ASSET_CONFIGURATIONS_PATH, assetMetadataHttp, type AssetRequestAuthority } from "./http.js";

export const ASSET_STATUS_PATH = "/__opencraft_assets/status";
export const ASSET_GIT_CONNECTIONS_PATH = "/__opencraft_assets/git-connections";
/** Personal ENV of the signed-in person (`AccountEnvironmentHttp` protocol). */
export const ASSET_ENVIRONMENT_PATH = "/__opencraft_assets/environment";

/** One request's verified login, as the composition's own identity provider
 * authenticated it. It is never read from a header, body or saved data. */
export interface IdentityAssetsRequest {
  /** The login principal; core resolves it to a Human Actor through its
   * identity binding. Its expiry bounds the request's proof. */
  readonly principal: LoginPrincipal;
  /** When the composition already knows the Actor, the proof must name it. */
  readonly actorId?: string;
  /** Whether this request's login is still the same current login, with the
   * same rights the composition admitted it under. */
  current(): boolean;
  /** Notifies on every change that can make `current()` false. */
  subscribe?(invalidated: () => void): () => void;
}
/** The vault Worker's settings methods (an `openAssetConfigurations` store or a
 * composition's own Worker port). They take the original Human proof; the
 * Worker derives the partition and the role from committed records. */
export type IdentityAssetsPort = OwnerCalls<AssetActorSettingsMethods> &
  Partial<OwnerCalls<AssetEnvironmentSettingsMethods>>;
export interface IdentityAssetsOptions extends OpenActorAdmissionOptions {
  /** The composition's authentication of one request, or `null`. */
  resolveRequest(request: IncomingMessage): IdentityAssetsRequest | null;
  readonly port: IdentityAssetsPort;
  /** The trusted public origin; every route is pinned to its host. */
  origin(): string;
  /** Only principals of this provider are admitted. */
  readonly provider?: string;
  /** Non-secret Git provider metadata the status route advertises. */
  readonly gitHosts?: readonly string[];
  readonly gitProviders?: readonly GitProviderDescriptor[];
  /** Serve personal ENV: the port's Worker issues execution ENV. */
  readonly environment?: boolean;
}

const live = (permit: Int32Array<SharedArrayBuffer>) => Atomics.load(permit, 0) === 1;
const retire = (permit: Int32Array<SharedArrayBuffer>) => {
  Atomics.store(permit, 0, 0);
};
const flag = () => {
  const value = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(value, 0, 1);
  return value;
};
const headers = {
  "content-type": "application/json",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

/** The Assets settings routes (`/__opencraft_assets/*`) for any principal a
 * trusted composition verifies, served by a vault Worker. Main holds the
 * request-local Human proof from core's `openActorAdmission` and the login
 * check; it never chooses a partition or a role and never sees a secret value.
 * One per host, on the Gateway main thread. */
export function openIdentityAssets(options: IdentityAssetsOptions) {
  const admission = openActorAdmission(options);
  const { port } = options;
  if (options.environment && (!port.environmentList || !port.environmentReplace || !port.environmentProjects))
    throw new Error("Personal ENV settings require the vault Worker");
  let closed = false;
  const pending = new Set<() => void>();
  const pinned = (request: IncomingMessage) => {
    try {
      const origin = new URL(options.origin());
      return (
        !closed &&
        ["http:", "https:"].includes(origin.protocol) &&
        origin.host === request.headers.host &&
        request.headers["sec-fetch-site"] !== "cross-site" &&
        request.headers.authorization === undefined
      );
    } catch {
      return false;
    }
  };
  /** The request's login and its original Human proof, or `null`. Settings are
   * browser-only: a bearer credential never reaches this resource. */
  const admit = (request: IncomingMessage) => {
    if (closed || request.headers.authorization !== undefined) return null;
    let resolved: IdentityAssetsRequest | null;
    try {
      resolved = options.resolveRequest(request);
      if (!resolved?.current()) return null;
    } catch {
      return null;
    }
    let proof: WorkspaceActorAdmission;
    try {
      proof = admission.admitPrincipal(
        resolved.principal,
        options.provider === undefined ? {} : { provider: options.provider },
      );
    } catch {
      return null;
    }
    if (resolved.actorId !== undefined && resolved.actorId !== proof.actorId) {
      retire(proof.requestPermit);
      return null;
    }
    const login = resolved;
    return {
      proof,
      scope: `actor:${proof.actorId}`,
      current: () => !closed && login.current() && live(proof.resourcePermit) && proof.expiresAt > Date.now(),
      subscribe(listener: () => void) {
        pending.add(listener);
        let dispose: (() => void) | undefined;
        try {
          dispose = login.subscribe?.(listener);
        } catch {
          listener();
        }
        return () => {
          pending.delete(listener);
          dispose?.();
        };
      },
    };
  };
  type Admitted = NonNullable<ReturnType<typeof admit>>;
  // The route's request permit replaces the proof's: it retires when the
  // response closes or the login changes, and the Worker checks it.
  const withPermit = (proof: WorkspaceActorAdmission, permit: Int32Array<SharedArrayBuffer>) =>
    Object.freeze({ ...proof, requestPermit: permit });
  const authority = (admitted: Admitted): AssetRequestAuthority => ({
    scope: admitted.scope,
    origin: options.origin(),
    expiresAt: admitted.proof.expiresAt,
    // Advisory only: the Worker decides both from the proof's committed role.
    allowCustomEndpoints: false,
    canManagePlatform: false,
    current: admitted.current,
    subscribe: admitted.subscribe,
  });
  const metadata = (
    path: string,
    read: (proof: WorkspaceActorAdmission) => Promise<unknown>,
    write: (proof: WorkspaceActorAdmission, input: unknown) => Promise<unknown>,
  ) => {
    return async (request: IncomingMessage, response: ServerResponse) => {
      const admitted = admit(request);
      try {
        await assetMetadataHttp(
          {
            snapshot: (asset) => read(withPermit(admitted!.proof, asset.permit)),
            update: (asset, input) => write(withPermit(admitted!.proof, asset.permit), input),
          },
          () => (admitted ? authority(admitted) : null),
          path,
        )(request, response);
      } finally {
        if (admitted) retire(admitted.proof.requestPermit);
      }
    };
  };
  const environment = async (request: IncomingMessage, response: ServerResponse) => {
    if (!pinned(request)) {
      response.writeHead(403, headers);
      response.end('{"error":"forbidden"}');
      return;
    }
    const admitted = admit(request),
      permit = flag();
    const stop = () => retire(permit);
    response.once("close", stop);
    const current = () => !!admitted && admitted.current() && live(permit);
    const unsubscribe = admitted?.subscribe(() => {
      if (!current()) stop();
    });
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        // The existing settings protocol, never an arbitrary Worker error.
        if (error instanceof SandboxConfigurationError) {
          if (error.code === "invalid" || error.code === "reserved" || error.code === "conflict")
            throw new EnvironmentError(error.code, error.status);
          if (error.code === "forbidden") throw new EnvironmentError("unavailable", 403);
        }
        throw new EnvironmentError("unavailable", 503);
      }
    };
    try {
      const proof = admitted ? withPermit(admitted.proof, permit) : null;
      await new AccountEnvironmentHttp({
        // The Worker rechecks this SAME proof at its own read/commit boundary.
        list: (_account, scope, assertCurrent) =>
          call(() => {
            assertCurrent();
            return port.environmentList!(proof!, scope);
          }),
        replace: (_account, scope, revision, input, assertCurrent) =>
          call(() => {
            assertCurrent();
            return port.environmentReplace!(proof!, scope, revision, input);
          }),
      }).handle(request, response, {
        account: admitted?.scope ?? "",
        current,
        projects: () =>
          call(async () => {
            if (!proof) throw new EnvironmentError("unavailable", 401);
            return [...(await port.environmentProjects!(proof))];
          }),
      });
    } finally {
      stop();
      response.removeListener("close", stop);
      unsubscribe?.();
      if (admitted) retire(admitted.proof.requestPermit);
    }
  };
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>([
    [
      ASSET_CONFIGURATIONS_PATH,
      metadata(
        ASSET_CONFIGURATIONS_PATH,
        (proof) => port.actorConfigurationsSnapshot(proof),
        (proof, input) => port.actorConfigurationsUpdate(proof, input),
      ),
    ],
    [
      ASSET_GIT_CONNECTIONS_PATH,
      metadata(
        ASSET_GIT_CONNECTIONS_PATH,
        (proof) => port.actorGitSnapshot(proof),
        (proof, input) => port.actorGitUpdate(proof, input),
      ),
    ],
    ...(options.environment ? [[ASSET_ENVIRONMENT_PATH, environment] as const] : []),
  ]);
  const status = (request: IncomingMessage, response: ServerResponse) => {
    const ok = pinned(request);
    const admitted = ok ? admit(request) : null;
    try {
      const code = closed ? 503 : !ok ? 403 : request.method !== "GET" ? 405 : 200;
      response.writeHead(code, headers);
      response.end(
        JSON.stringify(
          code === 200
            ? {
                version: 1,
                scope: admitted?.current() ? admitted.scope : null,
                gitHosts: options.gitHosts ?? [],
                gitProviders: options.gitProviders ?? [],
                ...(options.environment ? { environment: true } : {}),
              }
            : { error: "unavailable" },
        ),
      );
    } finally {
      if (admitted) retire(admitted.proof.requestPermit);
    }
  };
  return {
    /** The routes this service answers; others are left to the host. */
    paths: Object.freeze([ASSET_STATUS_PATH, ...routes.keys()]),
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const path = new URL(request.url ?? "/", "http://assets.invalid").pathname;
      if (path === ASSET_STATUS_PATH) {
        status(request, response);
        return true;
      }
      const route = routes.get(path);
      if (!route) return false;
      await route(request, response);
      return true;
    },
    /** Retires every in-flight request; the caller closes its Worker port. */
    close() {
      if (closed) return;
      closed = true;
      for (const revoke of [...pending]) revoke();
      admission.close();
    },
  };
}
