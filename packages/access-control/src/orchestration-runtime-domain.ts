import { AssistantThreadStore } from "./assistant-thread-store.js";
import { ThreadAccessStore } from "./thread-access.js";
import { PersonalAssistants } from "./personal-assistants.js";
import { channelSyncCommand } from "./native-channel-sync.js";
import { ActorStore } from "./actors.js";
import { Collaboration } from "./collaboration.js";
import { attachCrewRules } from "./crew-work.js";
import { communicationCommand } from "./communication-command.js";
import { ThreadOrchestrationLedger } from "./orchestration-ledger.js";
import { AutomationLedger } from "./automation-ledger.js";
import { updateExecutionRequest } from "./execution-request-state.js";
import type { ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import { orchestrationRuntimeRequest, type OrchestrationRuntimeRequest } from "./orchestration-runtime-contract.js";

/** The connection the orchestration runtime commits on. Without a `location`,
 * no service built here can start a companion Worker on the same file. */
export type OrchestrationRuntimeSource = Exclude<ServerDatabaseSource, string>;

/**
 * Orchestration runtime, communication and automation commands over one
 * Server connection. It runs only where that connection is owned: the Server
 * core owner Worker (Headless) or the standalone orchestration Worker. Each
 * command keeps its own transaction; callers run commands one at a time.
 * Never import it from a network thread. A failed command rolls back its own
 * transaction; it never retries here (the standalone Worker retries `SQLITE_BUSY`).
 */
export function orchestrationRuntimeDomain(source: OrchestrationRuntimeSource) {
  const db = source.database;
  let communication: Collaboration | undefined;
  let actors: ActorStore | undefined;
  let hasAutomation: boolean | undefined;
  const communicationService = () => {
    if (communication) return communication;
    communication = new Collaboration(
      source,
      (actors ??= new ActorStore(source, Date.now, { permissionProjection: false })),
      undefined,
      Date.now,
      (actorId) => db.prepare("SELECT enabled FROM actor_members WHERE actor_id=?").get(actorId)?.enabled !== 0,
    );
    // Crew rules use this connection; the network thread never loads them.
    attachCrewRules(communication, db, actors, Date.now);
    return communication;
  };
  return {
    /** Runs one request the owner entry already turned into the contract's union. */
    async execute(request: OrchestrationRuntimeRequest): Promise<unknown> {
      let result: unknown;
      const { method, payload } = request;
      const ledger = new ThreadOrchestrationLedger(
        db,
        () => ("now" in payload && typeof payload.now === "number" ? payload.now : undefined) ?? Date.now(),
      );
      switch (method) {
        // A lost acknowledgement must not replay an old title over a later one.
        case "claimTitleWrite":
          result =
            db
              .prepare(
                "UPDATE opencraft_orchestration_operations SET state='applying' WHERE operation_id=? AND state='accepted' AND result_json IS NULL",
              )
              .run(payload.operationId).changes === 1;
          break;
        case "finishTitleWrite":
          ledger.finish(payload.toolCallKey, payload.result);
          break;
        case "inheritChildCreator": {
          const { parent, child } = payload;
          result = db.transaction(() => {
            // The immutable creator is attribution. Keep the existing access mode
            // of a child already published by this or an earlier process.
            db.prepare(
              `INSERT OR IGNORE INTO thread_access
              SELECT ?, ?, (SELECT creator_actor_id FROM thread_access WHERE server_id=? AND thread_id=?),
                'shared', 1, ?`,
            ).run(child.serverId, child.threadId, parent.serverId, parent.threadId, Date.now());
            return db
              .prepare(
                `SELECT server_id AS serverId, thread_id AS threadId, creator_actor_id AS creatorActorId,
              access_mode AS accessMode, revision FROM thread_access WHERE server_id=? AND thread_id=?`,
              )
              .get(child.serverId, child.threadId);
          });
          break;
        }
        case "personalAssistantAssignments":
          result = new PersonalAssistants(communicationService(), db).assignments(payload.after);
          break;
        case "channelSync":
          result = channelSyncCommand(communicationService(), db, payload);
          break;
        case "assistantAllocation":
          result = db.transaction(() => new AssistantThreadStore(communicationService(), db).recordAllocation(payload));
          break;
        case "assistantAdmissions": {
          const service = communicationService(),
            store = new AssistantThreadStore(service, db);
          result = db
            .prepare(
              "SELECT o.thread_id,o.origin_json FROM opencraft_input_origins o JOIN actor_execution_requests r ON o.input_id='actor-input:'||r.id AND o.thread_id=r.thread_id WHERE r.state IN ('accepted','transferring','queued','unknown') LIMIT 10000",
            )
            .all()
            .flatMap((row) => {
              const grant = JSON.parse(String(row.origin_json)).assistantGrant;
              if (!grant) return [];
              try {
                return [
                  {
                    threadId: String(row.thread_id),
                    grant,
                    authority: store.guard(grant.actor, grant.profile, grant.revision, grant.epoch),
                    takenOver: service.orchestration.relation(String(row.thread_id))?.hasDirectUserInput ?? false,
                  },
                ];
              } catch {
                return [];
              }
            });
          break;
        }
        case "communication": {
          if (!payload.executionScope) {
            result = communicationCommand(communicationService(), db, payload);
            break;
          }
          const scope = payload.executionScope,
            actorStore = (actors ??= new ActorStore(source, Date.now, { permissionProjection: false }));
          const access = new ThreadAccessStore(source, actorStore, { projection: false });
          const unsupported = async () => {
            throw Error("Storage cannot call an engine");
          };
          // Every Server resolves to the scope's Host, as the fallback to `hostId` did.
          const scoped = new Collaboration(
            source,
            actorStore,
            {
              serverId: scope.serverId,
              hostId: scope.hostId,
              serverForThread: () => scope.serverId,
              hostForServer: () => scope.hostId,
              validate: unsupported,
              receipt: unsupported,
              add: unsupported,
              steer: unsupported,
              cancel: unsupported,
            },
            Date.now,
            (id) => db.prepare("SELECT enabled FROM actor_members WHERE actor_id=?").get(id)?.enabled !== 0,
            undefined,
            (c, r) => access.allows(r.serverId, r.threadId, c),
          );
          attachCrewRules(scoped, db, actorStore, Date.now);
          try {
            result = communicationCommand(scoped, db, payload);
          } finally {
            await scoped.close();
            access.close();
          }
          break;
        }
        case "automation": {
          const automation = new AutomationLedger(db, payload.now);
          const { operation, input } = payload;
          switch (operation) {
            case "command":
              result = automation.command(input.caller, input.command, input.body, input.key);
              break;
            case "grantReplay":
              result = automation.grantReplay(input.caller, input.command, input.body, input.key);
              break;
            case "grant":
              result = automation.grantCommand(input.caller, input.command, input.body, input.key);
              break;
            case "eligible":
              result = automation.eligible();
              break;
            case "recover":
              automation.recover();
              break;
            case "claim":
              result = automation.claim(input.id, input.revision, input.occurrenceId);
              break;
            case "settle":
              result = automation.settle(input.key, input.state, input.result, input.proof);
              break;
            case "delegation":
              result = automation.delegation(input.key, input.sourceThreadId);
              break;
            case "enqueue":
              result = automation.enqueue(input.key, input.id, input.threadId);
              break;
            case "projection":
              result = automation.projection();
              break;
            case "unknownRuns":
              result = automation.unknownRuns();
              break;
            case "runGrant":
              result = automation.runGrant(input.key);
              break;
            case "checkRunGrant":
              result = automation.checkRunGrant(input.key);
              break;
            case "checkDelegation":
              result = automation.checkDelegation(input.id);
              break;
            default:
              throw Error("Unknown automation operation");
          }
          break;
        }
        case "observe":
          ledger.observeSnapshot(payload.snapshot);
          break;
        case "admission":
          result =
            db
              .prepare(
                `SELECT a.* FROM conversation_authorities a WHERE a.thread_id=? AND a.input_id=?
          UNION ALL SELECT a.* FROM conversation_authorities a JOIN opencraft_input_authorities i ON i.authority_id=a.id
          WHERE i.thread_id=? AND i.input_id=? LIMIT 1`,
              )
              .get(payload.threadId, payload.inputId, payload.threadId, payload.inputId) ?? null;
          break;
        case "executionAuthority": {
          const { inputId, turnId } = payload.execution;
          const row = inputId
            ? db
                .prepare(
                  `SELECT a.* FROM conversation_authorities a WHERE a.thread_id=? AND a.input_id=?
            UNION ALL SELECT a.* FROM conversation_authorities a JOIN opencraft_input_authorities i ON i.authority_id=a.id
            WHERE i.thread_id=? AND i.input_id=? LIMIT 1`,
                )
                .get(payload.threadId, inputId, payload.threadId, inputId)
            : turnId
              ? db
                  .prepare(
                    `SELECT a.* FROM conversation_authorities a JOIN conversation_turn_authorities t ON t.authority_id=a.id
              WHERE t.thread_id=? AND t.turn_id=? UNION ALL SELECT * FROM conversation_authorities WHERE thread_id=? AND turn_id=? LIMIT 1`,
                  )
                  .get(payload.threadId, turnId, payload.threadId, turnId)
              : null;
          result =
            row &&
            (!turnId ||
              (row.thread_id === payload.threadId && row.turn_id === turnId) ||
              db
                .prepare(
                  "SELECT 1 FROM conversation_turn_authorities WHERE thread_id=? AND turn_id=? AND authority_id=?",
                )
                .get(payload.threadId, turnId, row.id))
              ? { ...row, turn_id: turnId ?? row.turn_id, execution_relation: ledger.relation(payload.threadId) }
              : null;
          break;
        }
        case "updateExecution":
          updateExecutionRequest(db, payload);
          break;
        case "targets":
          result = [
            ...new Set([
              ...ledger.observedRuntimeThreads(payload.includeTerminal),
              ...ledger
                .threads()
                .filter((thread) => payload.includeTerminal || !["idle", "error"].includes(thread.runtimeStatus))
                .map((thread) => thread.threadId),
              ...ledger.activeWaits().flatMap((ticket) => ticket.targetThreadIds),
            ]),
          ];
          break;
        case "work":
          result = db.transaction(() => {
            const { now } = payload;
            // The legacy standalone collaboration store cannot issue renewable authorities.
            hasAutomation ??= !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='automation_delegations'").get();
            const canRenew = hasAutomation ? `
              AND NOT EXISTS (
                SELECT 1 FROM automation_delegations d
                JOIN automation_runs r ON r.key=d.run_key
                WHERE r.state IN ('admitted','running','unknown')
                  AND d.authority_id=COALESCE(
                    (SELECT root_authority_id FROM opencraft_delegation_roots WHERE authority_id=a.id), a.id
                  )
              )
            ` : "";
            // A later explicit wait can authorize a notice that previously had
            // only an expired spawn delegation. Keep its original dedup key.
            db.prepare(`
              UPDATE opencraft_parent_notification_batches SET state='pending'
              WHERE rowid IN (
                SELECT b.rowid FROM opencraft_notification_authorities n
                JOIN conversation_authorities a ON a.id=n.authority_id
                CROSS JOIN opencraft_parent_notification_batches b
                WHERE a.expires_at>? AND b.batch_id=n.batch_id AND b.state='expired'
              )
            `).run(now);
            // Use the same precedence as notificationDelegation: explicit
            // authority first, then the earliest spawn with a joined authority.
            // Automation may extend the expiry of its root or descendants.
            db.prepare(`
              UPDATE opencraft_parent_notification_batches AS b SET state='expired'
              WHERE b.state='pending' AND (b.deliver_after_ms<=? OR b.max_deadline_ms<=?)
                AND EXISTS (
                  SELECT 1 FROM conversation_authorities a
                  WHERE a.id=COALESCE(
                    (SELECT n.authority_id FROM opencraft_notification_authorities n
                     JOIN conversation_authorities explicit ON explicit.id=n.authority_id
                     WHERE n.batch_id=b.batch_id),
                    (SELECT o.delegation_id FROM opencraft_orchestration_operations o
                     JOIN conversation_authorities spawn ON spawn.id=o.delegation_id
                     WHERE o.kind='spawn' AND o.target_thread_id=b.child_thread_id
                     ORDER BY o.created_at_ms LIMIT 1)
                  ) AND a.expires_at<=?
                  ${canRenew}
                )
            `).run(now, now, now);
            return { waits: ledger.activeWaits(), notifications: ledger.dueNotifications() };
          });
          break;
        case "pendingAcks":
          result = db
            .prepare("SELECT operation_id FROM opencraft_orchestration_acks LIMIT 16")
            .all()
            .map((row) => String(row.operation_id));
          break;
        case "acknowledge":
          db.prepare("DELETE FROM opencraft_orchestration_acks WHERE operation_id=?").run(payload.operationId);
          break;
        default:
          throw new Error("Unsupported orchestration storage operation");
      }
      return result;
    },
    async close(): Promise<void> {
      const service = communication;
      communication = undefined;
      try {
        await service?.close();
      } finally {
        actors?.close();
        actors = undefined;
      }
    },
  };
}

/**
 * Methods the Server core owner Worker serves for `OrchestrationRuntimeWorker`
 * over its owner connection, in FIFO order with every other owner domain.
 * The source carries no `location`, so nothing here opens another connection.
 */
export function orchestrationRuntimeOwnerMethods(owner: OrchestrationRuntimeSource) {
  const domain = orchestrationRuntimeDomain({ database: owner.database, outcome: owner.outcome });
  return {
    methods: {
      // Owner entry: the network thread's `OrchestrationRuntimeWorker` is the
      // only caller on this in-process owner port (see `orchestrationRuntimeRequest`).
      orchestrationRuntime: async (method: unknown, payload: unknown) =>
        domain.execute(orchestrationRuntimeRequest(method, payload)),
    },
    close: () => domain.close(),
  };
}
