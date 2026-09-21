import type { JsonRpcId } from "./appserver.ts";

export type ProtocolAuditDirection = "inbound" | "outbound";

export interface ProtocolAuditData {
  direction: ProtocolAuditDirection;
  method: string | null;
  rpcId: JsonRpcId | undefined;
  message?: unknown;
}

export interface ProtocolAuditEvent {
  type: "hypernode/protocol";
  seq: number;
  time: number;
  data: ProtocolAuditData;
}

export interface ProtocolAuditProjection {
  total: number;
  inbound: number;
  outbound: number;
  methods: Record<string, number>;
  last: {
    seq: number;
    direction: ProtocolAuditDirection;
    method: string;
    rpcId: JsonRpcId | undefined;
  } | null;
}

export interface ProtocolAuditReadResult {
  threadId: string;
  found: boolean;
  eventCount: number;
  events: ProtocolAuditEvent[];
  projection: ProtocolAuditProjection;
}

export interface ProtocolAuditPort {
  read(params?: Record<string, unknown>): ProtocolAuditReadResult;
}
