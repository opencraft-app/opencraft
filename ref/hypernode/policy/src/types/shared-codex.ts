import type { AppServerConnection } from "./appserver.ts";
import type { RuntimeRefreshResult } from "./account-config.ts";

export interface SharedCodexProfile {
  shareId: string;
  ownerUserId: string;
  ownerUsername: string;
  ownerProfileId: string;
  displayName: string;
  email: string | null;
  planType: string | null;
  publishedAtMs: number;
  updatedAtMs: number;
}

export interface SharedCodexActivationResult {
  share: SharedCodexProfile;
  runtimeRefresh: RuntimeRefreshResult;
}

export interface SharedCodexPort {
  list(): SharedCodexProfile[];
  activeForUser(userId: string | null | undefined): SharedCodexProfile | null;
  ensureActiveForUser(userId: string | null | undefined): SharedCodexProfile | null;
  shareForOwnerProfile(ownerUserId: string, profileId: string): SharedCodexProfile | null;
  publish(connection: AppServerConnection, profileId: string): SharedCodexProfile;
  unpublish(connection: AppServerConnection, shareId: string): boolean;
  activate(connection: AppServerConnection, shareId: string): SharedCodexActivationResult;
}
