export type PermissionModeName =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

export interface NativeStartOptions {
  readonly cwd: string;
  readonly sessionId: string;
  readonly model?: string;
  readonly permissionMode?: PermissionModeName;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
  readonly executable?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly systemPromptAppend?: string;
}

export interface NativeInitInfo {
  readonly sessionId: string;
  readonly version: string;
  readonly model: string;
  readonly permissionMode: string | null;
  readonly models: readonly ModelRow[];
  readonly capabilities: readonly string[];
  readonly pid: number | null;
}

export interface InterruptReceipt {
  readonly stillQueued: readonly string[];
  readonly cancelled: readonly string[];
}

export interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly resolvedModel?: string;
}

/** The narrow port the bridge state machine needs from the native SDK. */
export interface NativeSessionPort {
  readonly messages: AsyncIterable<unknown>;
  initialize(): Promise<NativeInitInfo>;
  push(text: string, uuid: string): Promise<void>;
  /** Fail the input transport out-of-band so a pending admission cannot wedge the queue. */
  failInput(error: Error): void;
  withdraw(uuid: string): boolean;
  interrupt(): Promise<InterruptReceipt>;
  close(): Promise<void>;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: PermissionModeName): Promise<void>;
}

export interface NativeFactory {
  start(options: NativeStartOptions): NativeSessionPort;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}
