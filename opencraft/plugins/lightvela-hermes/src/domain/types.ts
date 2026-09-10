export interface BotTerminalSession {
  sandboxId?: string;
  poolId: string;
  sessionId: string;
  region: string;
  instanceId: string;
  ownerUin: string;
  loginUin: string;
  appId: number;
  wsUrl: string;
  cols: number;
  rows: number;
  timeoutSeconds?: number;
  username?: string;
  workingDirectory?: string;
}
