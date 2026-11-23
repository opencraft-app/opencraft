import type { SqlDatabase } from "@opencraft/sql";

export type CreationReceipt =
  | { state: "claimed" }
  | { state: "created" | "submitted" | "first_rejected"; threadId: string }
  | { state: "rejected"; status: number; code: string };

export interface CreationReceiptKey {
  actorId: string;
  operationKey: string;
}

export interface CreationReceiptClaim extends CreationReceiptKey {
  serverId: string;
  fingerprint: string;
}

type Claim = { kind: "fresh" | "conflict" } | { kind: "existing"; receipt: CreationReceipt };

export interface CreationReceiptMethods {
  claimConversationCreation(input: CreationReceiptClaim): Claim;
  readConversationCreation(input: CreationReceiptKey & { serverId: string }): CreationReceipt | null;
  recordConversationAllocation(key: CreationReceiptKey, threadId: string): void;
  recordConversationFirstInput(key: CreationReceiptKey, state: "submitted" | "first_rejected"): void;
  rejectConversationAllocation(key: CreationReceiptKey, status: number, code: string): void;
}

function receipt(row: Record<string, unknown>): CreationReceipt {
  switch (row.state) {
    case "claimed":
      return { state: "claimed" };
    case "created":
    case "submitted":
    case "first_rejected":
      if (typeof row.thread_id === "string") return { state: row.state, threadId: row.thread_id };
      break;
    case "rejected":
      if (typeof row.rejection_status === "number" && typeof row.rejection_code === "string")
        return { state: "rejected", status: row.rejection_status, code: row.rejection_code };
      break;
  }
  throw new Error("Invalid conversation creation receipt");
}

/** Invoked only in the Server owner Worker. No creation payload is stored. */
export function conversationCreationReceiptMethods(db: SqlDatabase): CreationReceiptMethods {
  const read = db.prepare(`SELECT server_id, fingerprint, state, thread_id, rejection_status, rejection_code
    FROM conversation_creation_receipts WHERE actor_id=? AND operation_key=?`);
  const claim =
    db.prepare(`INSERT INTO conversation_creation_receipts(actor_id, operation_key, server_id, fingerprint, state)
    VALUES(?, ?, ?, ?, 'claimed') ON CONFLICT(actor_id, operation_key) DO NOTHING`);
  const allocate = db.prepare(`UPDATE conversation_creation_receipts SET state='created', thread_id=?
    WHERE actor_id=? AND operation_key=? AND state='claimed'`);
  const submit = db.prepare(`UPDATE conversation_creation_receipts SET state=?
    WHERE actor_id=? AND operation_key=? AND state='created'`);
  const reject =
    db.prepare(`UPDATE conversation_creation_receipts SET state='rejected', rejection_status=?, rejection_code=?
    WHERE actor_id=? AND operation_key=? AND state='claimed'`);

  const requireChange = ({ changes }: { changes: number | bigint }) => {
    if (Number(changes) !== 1) throw new Error("Conversation creation receipt did not advance");
  };

  return {
    claimConversationCreation({ actorId, operationKey, serverId, fingerprint }) {
      if (Number(claim.run(actorId, operationKey, serverId, fingerprint).changes) === 1) return { kind: "fresh" };
      const prior = read.get(actorId, operationKey);
      if (!prior) throw new Error("Claimed conversation creation receipt is missing");
      return prior.server_id === serverId && prior.fingerprint === fingerprint
        ? { kind: "existing", receipt: receipt(prior) }
        : { kind: "conflict" };
    },
    readConversationCreation({ actorId, operationKey, serverId }) {
      const row = read.get(actorId, operationKey);
      return row?.server_id === serverId ? receipt(row) : null;
    },
    recordConversationAllocation({ actorId, operationKey }, threadId) {
      requireChange(allocate.run(threadId, actorId, operationKey));
    },
    recordConversationFirstInput({ actorId, operationKey }, state) {
      requireChange(submit.run(state, actorId, operationKey));
    },
    rejectConversationAllocation({ actorId, operationKey }, status, code) {
      requireChange(reject.run(status, code, actorId, operationKey));
    },
  };
}
