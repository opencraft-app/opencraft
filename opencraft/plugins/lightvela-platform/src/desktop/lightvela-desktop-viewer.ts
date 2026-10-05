import { desktopTargetKey, type DesktopTarget } from "@opencraft/plugin-cloud-desktop/contract";
import { createDesktopWireSession } from "@opencraft/plugin-cloud-desktop/session-wire";
import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { LightVelaDesktopViewerAttachment, LightVelaDesktopViewerPort } from "./lightvela-desktop-provider";

type AccountPort = Pick<LightVelaAccountService, "getSnapshot" | "request">;

export interface LightVelaDesktopViewerOptions {
  readonly account: AccountPort;
  /** Explicit authenticated broker endpoints from product composition, not a
   * peer-supplied URL. This adapter does not invent a deployed route. */
  readonly attachmentsPath: string;
  readonly connectUrl: string;
  readonly openSocket?: (url: string) => WebSocket;
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop attachment");
  return value as Record<string, unknown>;
}

/** Owns scoped viewer authorization only. Neutral session-wire owns framing,
 * confirmation, media delivery and control lifetime; no product DOM here. */
export function createLightVelaDesktopViewerPort(options: LightVelaDesktopViewerOptions): LightVelaDesktopViewerPort {
  if (!/^\/[A-Za-z0-9_/-]+$/.test(options.attachmentsPath) || options.attachmentsPath.includes("..")) {
    throw new Error("Invalid desktop broker path");
  }
  const url = new URL(options.connectUrl);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Desktop broker requires a credential-free WSS endpoint");
  }
  const openSocket = options.openSocket ?? (endpoint => new WebSocket(endpoint));
  const identity = () => {
    const account = options.account.getSnapshot();
    if (account.session.status !== "authenticated" || !account.details.profile?.id) return null;
    return JSON.stringify([account.details.profile.id, account.region, account.authGeneration,
      account.session.epoch, account.credentialScope]);
  };
  return {
    async acquire(binding, resource, signal): Promise<LightVelaDesktopViewerAttachment> {
      signal.throwIfAborted();
      const expected = identity();
      const initial = options.account.getSnapshot();
      if (!expected || initial.details.profile?.id !== binding.target.principalId || initial.region !== binding.region) {
        throw new Error("Desktop identity unavailable");
      }
      const response = object(await options.account.request<unknown>(options.attachmentsPath, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: binding.target, instanceId: binding.instanceId,
          resourceId: resource.resourceId, preparationGenerationId: resource.preparationGenerationId,
          bindingRevision: binding.revision }),
      }));
      // Capture a usable release handle before validating the rest of a late DTO.
      const id = opaque(response.attachmentId) ? response.attachmentId : null;
      const releaseRemote = () => {
        // Never use a successor account's credential to release an old identity.
        // Backend expiry remains the fallback after sign-out/identity replacement.
        if (id && identity() === expected) void options.account.request(
          `${options.attachmentsPath}/${id}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
      };
      try {
        signal.throwIfAborted();
        const target = object(response.target);
        if (identity() !== expected || response.version !== 1 || !id || !opaque(response.ticket)
          || response.instanceId !== binding.instanceId || response.resourceId !== resource.resourceId
          || response.preparationGenerationId !== resource.preparationGenerationId
          || response.bindingRevision !== binding.revision || typeof response.incarnation !== "string" || !response.incarnation
          || !["conversationId", "serverId", "environmentId", "principalId"].every(key => typeof target[key] === "string")
          || desktopTargetKey(target as unknown as DesktopTarget) !== desktopTargetKey(binding.target)
          || typeof response.expiresAt !== "number" || !Number.isSafeInteger(response.expiresAt)
          || response.expiresAt <= Date.now() || response.expiresAt > Date.now() + 600_000) {
          throw new Error("Desktop attachment changed");
        }
        let ticket = response.ticket;
        const lifetime = new AbortController();
        let session: ReturnType<typeof createDesktopWireSession> | undefined;
        let released = false, opened = false;
        const expiry = setTimeout(() => attachment.release(), response.expiresAt - Date.now());
        const attachment: LightVelaDesktopViewerAttachment = {
          target: Object.freeze({ ...binding.target }), instanceId: binding.instanceId,
          resourceId: resource.resourceId, preparationGenerationId: resource.preparationGenerationId,
          incarnation: response.incarnation,
          async open(openSignal) {
            if (released || opened || identity() !== expected) throw new Error("Desktop attachment retired");
            const linked = AbortSignal.any([openSignal, lifetime.signal]);
            linked.throwIfAborted(); opened = true;
            session = createDesktopWireSession({ attachmentId: id, signal: linked,
              openSocket: () => {
                if (identity() !== expected) throw new Error("Desktop identity changed");
                return openSocket(url.href);
              },
              authenticate(send) {
                if (identity() !== expected || !ticket) throw new Error("Desktop identity changed");
                const scoped = ticket; ticket = "";
                send({ event: "desktop/attach", version: 1, attachmentId: id, ticket: scoped });
              },
            });
            return session;
          },
          release() {
            if (released) return;
            released = true; ticket = ""; clearTimeout(expiry);
            lifetime.abort(); session?.close(); releaseRemote();
          },
        };
        return attachment;
      } catch (error) { releaseRemote(); throw error; }
    },
  };
}
