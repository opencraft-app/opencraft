// Type-only request view consumed by identity providers. The node:http import
// is erased at build time; a Fetch adapter supplies a structurally equal view.
import type { IncomingMessage } from "node:http";
import type { Principal } from "./index.js";

export type IdentityRequest = Pick<IncomingMessage, "headers"> & Partial<Pick<IncomingMessage, "rawHeaders" | "method" | "url">>;
export interface IdentityProvider {
  authenticate(request: IdentityRequest): Principal | null;
  /** Authentication-owner enrichment using fresh independently verified directory evidence. */
  preparePrincipal?(principal: Principal): Promise<Principal>;
  trustedOrigin?(request: IdentityRequest): string | null;
  /** Revalidate server-owned browser sessions when a connection outlives its request. */
  isCurrent?(principal: Principal): boolean;
}
