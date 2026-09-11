export function canRunGatewayOperation(status: string): boolean {
  return status === "Running";
}

export function isGatewayOperationConfirmed(input: string, userID: string): boolean {
  return input.trim() === userID;
}

export function migrationRequestBody(userID: string, dryRun: boolean) {
  return { user_id: userID, dry_run: dryRun };
}

export function quotaResetRequestBody(dryRun: boolean) {
  return { dry_run: dryRun };
}

export function migrationNeedsLegacyKeyCleanup(previousGateway: string, legacyKeyRevoked?: boolean): boolean {
  return previousGateway === "ai_gateway" && legacyKeyRevoked === false;
}
