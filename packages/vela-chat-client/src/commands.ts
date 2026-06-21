import type { CommandAckWire } from "./wire";

export function commandAckRejectionMessage(ack: CommandAckWire) {
  return ack.status === "rejected" ? ack.message : null;
}

