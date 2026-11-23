import { SandboxFault } from "@opencraft/sandbox";
import type { SandboxProviderDefinition, SandboxProviderInstallation } from "@opencraft/sandbox/providers";
import type { DurableObjectContainer } from "./bindings.js";
import { cloudflareSandboxBackend } from "./index.js";

/** A container class is the Durable Object class name a Worker binds a container to
 * (`cloudflare://<class>`): a JavaScript identifier. */
export const CLOUDFLARE_CONTAINER_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const IMAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** Secret-free installation record of the `cloudflare` provider. The container itself
 * is a runtime object of the Durable Object, not configuration (see options). */
export interface CloudflareInstallation extends SandboxProviderInstallation {
  readonly backend: "cloudflare";
  /** Name of the image in `ctx.container.images` (the Wrangler `images` key), e.g. `base`. */
  readonly image: string;
  readonly diskMb?: number;
  readonly enableInternet?: boolean;
  /** Container inactivity backstop; the WorkspaceHost idle policy decides sleep. */
  readonly inactivityTimeoutMs?: number;
  /** Numeric `uid:gid` for broker processes. */
  readonly user?: string;
}
export interface CloudflareProviderOptions {
  /** The Durable Object class that owns `container`; the only accepted target. */
  readonly containerClass: string;
  /** `this.ctx.container` of that Durable Object. */
  readonly container: DurableObjectContainer;
  /** `this.ctx.waitUntil`, so a pending `monitor()` keeps the object resident. */
  waitUntil?(promise: Promise<unknown>): void;
}

/** Provider definition for the WorkspaceHost Durable Object's composition root: it
 * serves exactly the container class of the object it runs in. */
export function cloudflareSandboxProvider(
  options: CloudflareProviderOptions,
): SandboxProviderDefinition<CloudflareInstallation> {
  if (!CLOUDFLARE_CONTAINER_CLASS.test(options?.containerClass ?? "") || !options.container)
    throw new SandboxFault("SANDBOX_POLICY", "Invalid Cloudflare container class");
  return {
    id: "cloudflare",
    acceptsTarget: (target) => target === options.containerClass,
    createBackend(request) {
      const installation = request.installation;
      const image =
        typeof installation.image === "string" && IMAGE_NAME.test(installation.image)
          ? options.container.images?.[installation.image]
          : undefined;
      if (request.templateId !== options.containerClass || !image)
        throw new SandboxFault("SANDBOX_POLICY", "Cloudflare container class or image is not served here");
      return cloudflareSandboxBackend({
        container: options.container,
        image,
        ...(request.python === undefined ? {} : { python: request.python }),
        ...(installation.diskMb === undefined ? {} : { diskMb: installation.diskMb }),
        ...(installation.enableInternet === undefined ? {} : { enableInternet: installation.enableInternet }),
        ...(installation.inactivityTimeoutMs === undefined
          ? {}
          : { inactivityTimeoutMs: installation.inactivityTimeoutMs }),
        ...(installation.user === undefined ? {} : { user: installation.user }),
        requestTimeoutMs: request.requestTimeoutMs,
        ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      });
    },
  };
}
