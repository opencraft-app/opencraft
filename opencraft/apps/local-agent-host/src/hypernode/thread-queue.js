// Source: HyperNode transparent-thread-queue.ts; storage class and helper bodies preserved.
import {randomUUID as uuidV4} from "node:crypto";
export class ThreadQueueStore {
    sql;
    memory = new Map();
    pausedMemory = new Set();
    createId;
    now;
    constructor(storage, createId = uuidV4, now = Date.now) {
        this.sql = storage?.available === true ? storage.sql : null;
        this.createId = createId;
        this.now = now;
        if (this.sql)
            this.initializeSchema();
    }
    initializeSchema() {
        this.sql?.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_queue_submissions (
        thread_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        client_user_message_id TEXT NOT NULL,
        actor_user_id TEXT,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(thread_id, submission_id),
        UNIQUE(thread_id, client_user_message_id)
      )
    `);
        this.sql?.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_thread_queue_pending
      ON hypernode_thread_queue_submissions(thread_id, state, position)
    `);
        this.sql?.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_thread_queue_actor
      ON hypernode_thread_queue_submissions(actor_user_id, state)
    `);
        this.sql?.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_queue_state (
        thread_id TEXT PRIMARY KEY,
        paused_reason TEXT,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    }
    add(threadId, clientUserMessageId, actorUserId, input) {
        const existing = this.findByClientId(threadId, clientUserMessageId);
        if (existing)
            return { submission: existing, created: false };
        const at = this.now();
        const submission = {
            threadId,
            id: this.createId(),
            clientUserMessageId,
            actorUserId,
            input: structuredCopy(input),
            state: "queued",
            position: this.nextPosition(threadId),
            createdAtMs: at,
            updatedAtMs: at,
        };
        if (this.sql) {
            this.sql.exec(`
        INSERT INTO hypernode_thread_queue_submissions(
          thread_id, submission_id, client_user_message_id, actor_user_id,
          input_json, state, position, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `, submission.threadId, submission.id, submission.clientUserMessageId, submission.actorUserId, JSON.stringify(submission.input), submission.position, submission.createdAtMs, submission.updatedAtMs);
        }
        else {
            const rows = this.memory.get(threadId) ?? [];
            rows.push(submission);
            this.memory.set(threadId, rows);
        }
        return { submission, created: true };
    }
    findByClientId(threadId, clientUserMessageId) {
        if (this.sql) {
            return hydrate(this.sql
                .exec(`
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND client_user_message_id = ?
      `, threadId, clientUserMessageId)
                .toArray()[0]);
        }
        return (this.memory
            .get(threadId)
            ?.find((row) => row.clientUserMessageId === clientUserMessageId) ?? null);
    }
    find(threadId, submissionId) {
        if (this.sql) {
            return hydrate(this.sql
                .exec(`
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND submission_id = ?
      `, threadId, submissionId)
                .toArray()[0]);
        }
        return (this.memory.get(threadId)?.find((row) => row.id === submissionId) ?? null);
    }
    pending(threadId) {
        if (this.sql) {
            return this.sql
                .exec(`
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND state = 'queued'
        ORDER BY position, created_at_ms, submission_id
      `, threadId)
                .toArray()
                .map(hydrate)
                .filter(notNull);
        }
        return (this.memory.get(threadId) ?? [])
            .filter((row) => row.state === "queued")
            .sort(compareQueue)
            .map(cloneSubmission);
    }
    update(threadId, submissionId, input) {
        const row = this.find(threadId, submissionId);
        if (!row || row.state !== "queued")
            return null;
        const at = this.now();
        if (this.sql) {
            this.sql.exec(`
        UPDATE hypernode_thread_queue_submissions
        SET input_json = ?, updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `, JSON.stringify(input), at, threadId, submissionId);
        }
        else {
            const stored = this.memory
                .get(threadId)
                ?.find((item) => item.id === submissionId);
            if (stored) {
                stored.input = structuredCopy(input);
                stored.updatedAtMs = at;
            }
        }
        return this.find(threadId, submissionId);
    }
    delete(threadId, submissionId) {
        const row = this.find(threadId, submissionId);
        if (!row || row.state !== "queued")
            return false;
        const at = this.now();
        if (this.sql) {
            this.sql.exec(`
        UPDATE hypernode_thread_queue_submissions
        SET state = 'deleted', updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `, at, threadId, submissionId);
        }
        else {
            rowInMemory(this.memory, threadId, submissionId, (stored) => {
                stored.state = "deleted";
                stored.updatedAtMs = at;
            });
        }
        if (this.pending(threadId).length === 0)
            this.resume(threadId);
        return true;
    }
    reorder(threadId, ids) {
        const rows = this.pending(threadId);
        if (rows.length !== ids.length ||
            new Set(ids).size !== ids.length ||
            rows.some((row) => !ids.includes(row.id)))
            return false;
        const at = this.now();
        if (this.sql) {
            for (const [index, id] of ids.entries()) {
                this.sql.exec(`
          UPDATE hypernode_thread_queue_submissions
          SET position = ?, updated_at_ms = ?
          WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
        `, index + 1, at, threadId, id);
            }
        }
        else {
            for (const [index, id] of ids.entries()) {
                rowInMemory(this.memory, threadId, id, (stored) => {
                    stored.position = index + 1;
                    stored.updatedAtMs = at;
                });
            }
        }
        return true;
    }
    markDispatched(threadId, submissionId) {
        const at = this.now();
        if (this.sql) {
            this.sql.exec(`
        UPDATE hypernode_thread_queue_submissions
        SET state = 'dispatched', updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `, at, threadId, submissionId);
        }
        else {
            rowInMemory(this.memory, threadId, submissionId, (stored) => {
                stored.state = "dispatched";
                stored.updatedAtMs = at;
            });
        }
    }
    pendingThreadsForActor(actorUserId) {
        if (this.sql) {
            return this.sql
                .exec(`
        SELECT DISTINCT thread_id FROM hypernode_thread_queue_submissions
        WHERE actor_user_id = ? AND state = 'queued'
      `, actorUserId)
                .toArray()
                .map((row) => row.thread_id);
        }
        const result = [];
        for (const [threadId, rows] of this.memory) {
            if (rows.some((row) => row.actorUserId === actorUserId && row.state === "queued")) {
                result.push(threadId);
            }
        }
        return result;
    }
    pauseAfterInterruption(threadId) {
        if (this.pending(threadId).length === 0) {
            this.resume(threadId);
            return;
        }
        const at = this.now();
        if (this.sql) {
            this.sql.exec(`
        INSERT INTO hypernode_thread_queue_state(thread_id, paused_reason, updated_at_ms)
        VALUES(?, 'interrupted', ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          paused_reason = 'interrupted', updated_at_ms = excluded.updated_at_ms
      `, threadId, at);
            return;
        }
        this.pausedMemory.add(threadId);
    }
    resume(threadId) {
        if (this.sql) {
            this.sql.exec(`DELETE FROM hypernode_thread_queue_state WHERE thread_id = ?`, threadId);
            return;
        }
        this.pausedMemory.delete(threadId);
    }
    isPaused(threadId) {
        if (this.sql) {
            return (this.sql
                .exec(`
        SELECT paused_reason FROM hypernode_thread_queue_state
        WHERE thread_id = ? AND paused_reason = 'interrupted'
      `, threadId)
                .toArray().length > 0);
        }
        return this.pausedMemory.has(threadId);
    }
    nextPosition(threadId) {
        if (this.sql) {
            const row = this.sql
                .exec(`
        SELECT COALESCE(MAX(position), 0) + 1 AS position
        FROM hypernode_thread_queue_submissions WHERE thread_id = ?
      `, threadId)
                .toArray()[0];
            return Number(row?.position ?? 1);
        }
        return (Math.max(0, ...(this.memory.get(threadId) ?? []).map((row) => row.position)) + 1);
    }
}
function hydrate(row) {
    if (!row)
        return null;
    let input = [];
    try {
        const parsed = JSON.parse(row.input_json);
        if (Array.isArray(parsed))
            input = parsed;
    }
    catch { }
    const state = row.state === "dispatched" || row.state === "deleted"
        ? row.state
        : "queued";
    return {
        threadId: row.thread_id,
        id: row.submission_id,
        clientUserMessageId: row.client_user_message_id,
        actorUserId: row.actor_user_id,
        input,
        state,
        position: Number(row.position),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
    };
}
function notNull(value) {
    return value !== null;
}
function rowInMemory(memory, threadId, submissionId, mutate) {
    const row = memory.get(threadId)?.find((item) => item.id === submissionId);
    if (row)
        mutate(row);
}
function compareQueue(left, right) {
    return (left.position - right.position ||
        left.createdAtMs - right.createdAtMs ||
        left.id.localeCompare(right.id));
}
function cloneSubmission(row) {
    return { ...row, input: structuredCopy(row.input) };
}
function structuredCopy(value) {
    return JSON.parse(JSON.stringify(value));
}
