import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";

const schema = `
CREATE TABLE gateway_limits(actor TEXT PRIMARY KEY, monthly_tokens INTEGER NOT NULL CHECK(monthly_tokens>=0), request_tokens INTEGER NOT NULL CHECK(request_tokens>0), concurrency INTEGER NOT NULL CHECK(concurrency>0), revision INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_sponsors(thread TEXT PRIMARY KEY, actor TEXT NOT NULL, parent TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_requests(id TEXT PRIMARY KEY, actor TEXT NOT NULL, thread TEXT NOT NULL, model TEXT NOT NULL, credential TEXT, period TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>0), actual INTEGER CHECK(actual>=0), state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released','unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX gateway_requests_actor ON gateway_requests(actor,period,state);
CREATE TABLE gateway_contributions(provider TEXT PRIMARY KEY, actor TEXT NOT NULL, template_provider TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','shared','withdrawn')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
`;

const scopeMigration = `
ALTER TABLE gateway_contributions ADD COLUMN scope TEXT NOT NULL DEFAULT 'team' CHECK(scope IN ('personal','team'));
CREATE TABLE gateway_thread_humans(thread TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(thread,actor)) STRICT;
CREATE TABLE gateway_private_threads(thread TEXT PRIMARY KEY, actor TEXT NOT NULL) STRICT;
`;

export type ModelGatewayKeyScope = "personal" | "team";

const executionMigration = `
CREATE TABLE gateway_executions(id TEXT PRIMARY KEY, thread TEXT NOT NULL, authorizer TEXT NOT NULL, executor TEXT, model TEXT NOT NULL, parent TEXT, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','closed','revoked')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE gateway_execution_heads(thread TEXT PRIMARY KEY, execution TEXT NOT NULL) STRICT;
ALTER TABLE gateway_executions ADD COLUMN authority TEXT;
CREATE TABLE gateway_execution_turns(thread TEXT NOT NULL, turn TEXT NOT NULL, execution TEXT NOT NULL, PRIMARY KEY(thread,turn)) STRICT;
ALTER TABLE gateway_requests ADD COLUMN execution TEXT;
ALTER TABLE gateway_requests ADD COLUMN key_owner TEXT;
UPDATE gateway_requests SET key_owner=(SELECT c.actor FROM gateway_contributions c WHERE
  COALESCE(gateway_requests.credential,gateway_requests.model)=c.provider OR
  substr(COALESCE(gateway_requests.credential,gateway_requests.model),1,length('configured/'||c.provider||'/'))='configured/'||c.provider||'/' LIMIT 1);
ALTER TABLE gateway_contributions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE gateway_personal_limits(actor TEXT PRIMARY KEY, monthly_tokens INTEGER NOT NULL CHECK(monthly_tokens>=0), revision INTEGER NOT NULL) STRICT;
`;

/** Model-only delegation captured at authenticated Thread creation, not inferred
 * from analytics or whoever next opens/sends to the Thread. */
const admissionLeaseSchema = `
ALTER TABLE gateway_executions ADD COLUMN admission TEXT;
ALTER TABLE gateway_execution_turns ADD COLUMN admission TEXT;
`;

const conversationModelMigration = `
CREATE TABLE gateway_thread_models(thread TEXT PRIMARY KEY, creator TEXT NOT NULL, provider TEXT NOT NULL, contribution_revision INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
ALTER TABLE gateway_requests ADD COLUMN turn TEXT;
ALTER TABLE gateway_requests ADD COLUMN input_tokens INTEGER;
ALTER TABLE gateway_requests ADD COLUMN output_tokens INTEGER;
ALTER TABLE gateway_requests ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE gateway_requests ADD COLUMN cache_write_tokens INTEGER;
CREATE INDEX gateway_requests_turn ON gateway_requests(thread,turn);
`;

export interface ModelGatewayTokenUsage {
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
}

/** Trusted admission evidence, never accepted from inference JSON. */
export interface ModelGatewayExecution {
  id: string; authorizer: string; executor: string | null; model: string;
  expiresAt: number; parent?: string | null;
  authorityId?: string;
}

export class ModelGatewayError extends Error {
  constructor(readonly kind: string, readonly status = 429) { super(kind); }
}
export interface ModelGatewayLimit { monthlyTokens: number; requestTokens: number; concurrency: number }
const identifier = (value: string) => {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\x00-\x1f]/u.test(value)) throw new ModelGatewayError("invalid_gateway_identity", 400);
  return value;
};
const count = (n: number, minimum = 0) => {
  if (!Number.isSafeInteger(n) || n < minimum || n > 1_000_000_000_000) throw new ModelGatewayError("invalid_gateway_limit", 400);
  return n;
};

/** Admission ledger, deliberately separate from participant-allocation analytics.
 * Every process uses the same local SQLite file. BEGIN IMMEDIATE serializes
 * admission with policy changes; unknown upstream outcomes retain their hold.
 */
export class ModelGatewayStore {
  private readonly managed;
  private readonly db;
  constructor(path: string, private readonly now = Date.now) {
    if (path !== ":memory:" && !isAbsolute(path)) throw new ModelGatewayError("gateway_path_must_be_absolute", 503);
    this.managed = openManagedDatabase({ schemaId: "model-gateway", path, migrations: [{ version: 1, name: "model-gateway", sql: schema }, { version: 2, name: "personal-keys", sql: scopeMigration }, {version: 3, name: "execution-authority", sql: executionMigration}, {version: 4, name: "conversation-model-binding", sql: conversationModelMigration}],
      legacyPolicy: "reject", validateSchema: createSchemaValidator(schema + scopeMigration + executionMigration + conversationModelMigration + admissionLeaseSchema) });
    this.db = this.managed.database;
    this.db.exec("PRAGMA busy_timeout=5000");
  }
  get outcome() { return this.managed.outcome; }
  close() { this.db.close(); }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private audit(actor: string, action: string, subject: string, detail: unknown) {
    this.db.prepare("INSERT INTO gateway_audit(actor,action,subject,detail,at) VALUES(?,?,?,?,?)")
      .run(identifier(actor), action, subject, JSON.stringify(detail), this.now());
  }
  configure(actor: string, limit: ModelGatewayLimit, expectedRevision: number, administrator: string) {
    identifier(actor); identifier(administrator); count(expectedRevision);
    count(limit.monthlyTokens); count(limit.requestTokens, 1); count(limit.concurrency, 1);
    if (limit.concurrency > 1000) throw new ModelGatewayError("invalid_gateway_limit", 400);
    return this.transaction(() => {
      const before = this.limit(actor, false);
      if ((before?.revision ?? 0) !== expectedRevision) throw new ModelGatewayError("gateway_revision_conflict", 409);
      this.db.prepare("INSERT INTO gateway_limits VALUES(?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET monthly_tokens=excluded.monthly_tokens,request_tokens=excluded.request_tokens,concurrency=excluded.concurrency,revision=excluded.revision")
        .run(actor, limit.monthlyTokens, limit.requestTokens, limit.concurrency, expectedRevision + 1);
      this.audit(administrator, "configure", actor, { before, after: limit, revision: expectedRevision + 1 });
      return this.limit(actor, false)!;
    });
  }
  limit(actor: string, fallback = true) {
    identifier(actor);
    const row = this.db.prepare("SELECT * FROM gateway_limits WHERE actor=?").get(actor)
      ?? (fallback ? this.db.prepare("SELECT * FROM gateway_limits WHERE actor='*'").get() : undefined);
    return row ? { monthlyTokens: Number(row.monthly_tokens), requestTokens: Number(row.request_tokens), concurrency: Number(row.concurrency), revision: Number(row.revision) } : null;
  }
  sponsor(thread: string): string | null {
    identifier(thread);
    return this.db.prepare("SELECT actor FROM gateway_sponsors WHERE thread=?").get(thread)?.actor as string | undefined ?? null;
  }
  execution(thread: string) {
    const row = this.db.prepare("SELECT e.* FROM gateway_executions e JOIN gateway_execution_heads h ON h.execution=e.id WHERE h.thread=?").get(identifier(thread));
    return row ? {id:String(row.id), thread:String(row.thread), authorizer:String(row.authorizer), executor:row.executor === null ? null : String(row.executor), model:String(row.model), parent:row.parent === null ? null : String(row.parent), expiresAt:Number(row.expires_at), state:String(row.state), admission:row.admission === null ? null : String(row.admission)} : null;
  }
  executionForAuthority(authority: string): string | null {
    return this.db.prepare("SELECT id FROM gateway_executions WHERE authority=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(identifier(authority))?.id as string|undefined??null;
  }
  private currentExecution(id: string, allowClosed = false) {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current) || seen.size >= 64) throw new ModelGatewayError("gateway_execution_invalid", 403);
      seen.add(current);
      const row: Record<string, unknown> | undefined = this.db.prepare("SELECT * FROM gateway_executions WHERE id=?").get(current);
      // A completed parent can leave admitted children working; revocation and expiry propagate.
      if (!row || row.state === "revoked" || !allowClosed && current === id && row.state !== "active" || Number(row.expires_at) <= this.now()) throw new ModelGatewayError("gateway_execution_expired", 403);
      current = row.parent === null ? null : String(row.parent);
    }
  }
  /** Called only from trusted successful creation custody. This is a narrow
   * conversation model grant, never an ENV/Git grant or a team-wide key share. */
  bindConversationModel(thread: string, creator: string, model: string) {
    identifier(thread); identifier(creator); identifier(model);
    const provider = this.modelProvider(model);
    if (!provider) return;
    this.transaction(() => {
      const key = this.contribution(provider);
      if (!key) return;
      if (key.state !== 'shared' || key.scope === 'personal' && key.actor !== creator)
        throw new ModelGatewayError('gateway_personal_key_forbidden', 403);
      const existing = this.conversationModel(thread);
      if (existing) {
        if (existing.creator !== creator || existing.provider !== provider || existing.revision !== key.revision)
          throw new ModelGatewayError('gateway_conversation_model_changed', 409);
        return;
      }
      this.db.prepare('INSERT INTO gateway_thread_models VALUES(?,?,?,?,?)').run(thread, creator, provider, key.revision, this.now());
      this.audit(creator, 'conversation.model.bind', thread, { provider, revision: key.revision });
    });
  }
  conversationModel(thread: string) {
    const row = this.db.prepare('SELECT creator,provider,contribution_revision FROM gateway_thread_models WHERE thread=?').get(identifier(thread));
    return row ? { creator: String(row.creator), provider: String(row.provider), revision: Number(row.contribution_revision) } : null;
  }
  private modelProvider(model: string): string | null {
    if (!model.startsWith('configured/')) return null;
    const parts = model.slice('configured/'.length).split('/');
    try { if (parts.length === 2) return identifier(decodeURIComponent(parts[0]!)); } catch { /* invalid route */ }
    throw new ModelGatewayError('invalid_gateway_identity', 400);
  }
  /** The caller must separately hold current execution/Thread authorization.
   * A binding is not permission for a viewer to execute, nor a model catalog grant. */
  private canUseForExecution(thread: string, provider: string, actor: string, parent: string | null = null): boolean {
    if (this.canUse(provider, actor)) return true;
    const key = this.contribution(provider), seen = new Set<string>();
    if (!key || key.state !== 'shared' || key.scope !== 'personal') return false;
    for (;;) {
      const binding = this.conversationModel(thread);
      if (binding?.provider === provider && binding.creator === key.actor && binding.revision === key.revision) return true;
      // Only an explicit model-execution delegation may inherit the route.
      // Thread topology, view ancestry and statistics are not spending grants.
      if (!parent || seen.has(parent) || seen.size >= 64) return false;
      seen.add(parent);
      const row = this.db.prepare('SELECT thread,authorizer,model,parent FROM gateway_executions WHERE id=?').get(parent);
      if (!row || row.authorizer !== actor || this.modelProvider(String(row.model)) !== provider) return false;
      thread = String(row.thread); parent = row.parent === null ? null : String(row.parent);
    }
  }
  beginExecution(thread: string, input: ModelGatewayExecution) {
    identifier(thread); identifier(input.id); identifier(input.authorizer); identifier(input.model);
    if(input.executor !== null) identifier(input.executor);
    if(input.authorityId !== undefined)identifier(input.authorityId);
    if(!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now() || input.expiresAt > this.now()+86_400_000) throw new ModelGatewayError("gateway_execution_expired",403);
    return this.transaction(() => {
      if(input.model.startsWith("configured/")) {
        const provider=decodeURIComponent(input.model.slice("configured/".length).split("/")[0]!);
        if(!this.canUseForExecution(thread,provider,input.authorizer,input.parent??null))throw new ModelGatewayError("gateway_personal_key_forbidden",403);
      }
      const previous = this.execution(thread);
      if (previous?.id === input.id) {
        // Admission is a lease, not an idempotent read. A second owner must not
        // dispatch or later clean up the first owner's still-active execution.
        if (previous.state === "active") throw new ModelGatewayError("gateway_execution_busy",409);
        if(previous.authorizer !== input.authorizer || previous.model !== input.model || previous.executor !== input.executor) throw new ModelGatewayError("gateway_execution_changed",409);
        if(previous.state !== "closed" || previous.expiresAt <= this.now()) throw new ModelGatewayError("gateway_execution_expired",403);
        const admission=randomUUID();
        this.db.prepare("UPDATE gateway_executions SET state='active',admission=? WHERE id=?").run(admission,input.id);
        this.currentExecution(input.id);
        return this.execution(thread)!;
      }
      if (previous?.state === "active" && previous.expiresAt > this.now()) throw new ModelGatewayError("gateway_execution_busy",409);
      const parent = input.parent ? this.db.prepare("SELECT * FROM gateway_executions WHERE id=?").get(identifier(input.parent)) : null;
      if(input.parent) {
        this.currentExecution(input.parent,true);
        if(!parent || parent.authorizer !== input.authorizer || parent.model !== input.model || input.expiresAt > Number(parent.expires_at)) throw new ModelGatewayError("gateway_delegation_forbidden",403);
      }
      this.db.prepare("INSERT INTO gateway_executions(id,thread,authorizer,executor,model,parent,expires_at,state,created_at,authority,admission) VALUES(?,?,?,?,?,?,?,'active',?,?,?)").run(input.id,thread,input.authorizer,input.executor,input.model,input.parent??null,input.expiresAt,this.now(),input.authorityId??null,randomUUID());
      this.db.prepare("INSERT INTO gateway_execution_heads VALUES(?,?) ON CONFLICT(thread) DO UPDATE SET execution=excluded.execution").run(thread,input.id);
      this.audit(input.authorizer,"execution.authorize",input.id,{thread,executor:input.executor,model:input.model,parent:input.parent??null,expiresAt:input.expiresAt});
      return this.execution(thread)!;
    });
  }
  endExecution(thread: string, id: string, revoke = false, admission?: string) {
    this.db.prepare("UPDATE gateway_executions SET state=? WHERE id=? AND thread=? AND state<>'revoked' AND (? IS NULL OR admission=?)")
      .run(revoke?"revoked":"closed",identifier(id),identifier(thread),admission??null,admission??null);
  }
  startedExecution(thread: string, turn: string, id?: string) {
    const current=this.execution(thread),execution=id??current?.id;
    if(execution && current?.id===execution && current.state==='active')this.db.prepare("INSERT OR IGNORE INTO gateway_execution_turns(thread,turn,execution,admission) VALUES(?,?,?,?)")
      .run(identifier(thread),identifier(turn),identifier(execution),current.admission);
  }
  finishedExecution(thread: string, turn: string) {
    // A late completion can refine the old turn, but cannot close a new lease
    // that reused the same logical input/execution ID after an explicit retry.
    this.db.prepare("UPDATE gateway_executions SET state='closed' WHERE thread=? AND state='active' AND EXISTS (SELECT 1 FROM gateway_execution_turns t WHERE t.thread=? AND t.turn=? AND t.execution=gateway_executions.id AND t.admission IS gateway_executions.admission)")
      .run(identifier(thread),thread,identifier(turn));
  }
  steerExecution(thread: string, authorizer: string) {
    const execution=this.execution(thread);
    if(!execution) throw new ModelGatewayError("gateway_execution_required",403);
    this.currentExecution(execution.id);
    if(execution.authorizer !== authorizer) throw new ModelGatewayError("gateway_execution_owner_required",403);
  }
  /** Trusted native ingress has already authorized shared Thread input control.
   * Continue only this exact execution; never transfer sponsor, budget or identity. */
  steerSharedExecution(thread: string, expectedExecutionId: string) {
    const execution = this.execution(thread);
    if (!execution || execution.id !== expectedExecutionId) throw new ModelGatewayError("gateway_execution_changed", 403);
    this.currentExecution(execution.id);
  }
  personalLimit(actor: string) {
    const row=this.db.prepare("SELECT * FROM gateway_personal_limits WHERE actor=?").get(identifier(actor));
    return {monthlyTokens:row?Number(row.monthly_tokens):null,revision:row?Number(row.revision):0};
  }
  setPersonalLimit(actor: string, monthlyTokens: number, revision: number) {
    identifier(actor);count(monthlyTokens);count(revision);
    return this.transaction(()=>{
      if(this.personalLimit(actor).revision!==revision)throw new ModelGatewayError("gateway_revision_conflict",409);
      this.db.prepare("INSERT INTO gateway_personal_limits VALUES(?,?,?) ON CONFLICT(actor) DO UPDATE SET monthly_tokens=excluded.monthly_tokens,revision=excluded.revision").run(actor,monthlyTokens,revision+1);
      return this.personalLimit(actor);
    });
  }
  /** Only trusted execution admission calls this. A conversation has one stable
   * sponsor; joining or steering someone else's conversation never transfers its bill. */
  bind(thread: string, actor: string | null, parent: string | null = null): string {
    identifier(thread); if (actor !== null) identifier(actor); if (parent !== null) identifier(parent);
    return this.transaction(() => {
      const existing = this.sponsor(thread);
      // A trusted human input must never borrow a personal-key conversation.
      if (actor) {
        let ancestor: string | null = thread;
        const seen = new Set<string>();
        while (ancestor) {
          if (seen.has(ancestor) || seen.size >= 64) throw new ModelGatewayError("gateway_sponsor_cycle", 403);
          seen.add(ancestor);
          const locked = this.db.prepare("SELECT actor FROM gateway_private_threads WHERE thread=?").get(ancestor);
          if (locked && locked.actor !== actor) throw new ModelGatewayError("gateway_personal_key_forbidden", 403);
          const next: unknown = ancestor === thread && parent ? parent : this.db.prepare("SELECT parent FROM gateway_sponsors WHERE thread=?").get(ancestor)?.parent;
          ancestor = typeof next === "string" ? next : null;
        }
        this.db.prepare("INSERT OR IGNORE INTO gateway_thread_humans VALUES(?,?)").run(thread, actor);
      }
      if (existing) return existing;
      const inherited = parent ? this.sponsor(parent) : null;
      if (parent && !inherited) throw new ModelGatewayError("gateway_parent_sponsor_missing", 403);
      const sponsor = inherited ?? actor;
      if (!sponsor || sponsor === "*") throw new ModelGatewayError("gateway_human_sponsor_required", 403);
      this.db.prepare("INSERT INTO gateway_sponsors VALUES(?,?,?,?)").run(thread, sponsor, parent, this.now());
      this.audit(sponsor, "bind", thread, { parent });
      return sponsor;
    });
  }
  summary(actor: string, period = new Date(this.now()).toISOString().slice(0, 7)) {
    identifier(actor);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(period)) throw new ModelGatewayError("invalid_gateway_period", 400);
    const row = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) AS used,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched','unknown') THEN reserved ELSE 0 END),0) AS held,
      COALESCE(SUM(CASE WHEN state IN ('reserved','dispatched','unknown') THEN 1 ELSE 0 END),0) AS unresolved
      FROM gateway_requests WHERE (actor=? OR key_owner=?) AND period=?`).get(actor, actor, period)!;
    const active = this.db.prepare("SELECT COUNT(*) AS n FROM gateway_requests WHERE (actor=? OR key_owner=?) AND state IN ('reserved','dispatched','unknown')").get(actor,actor)!;
    return { actor, period, usedTokens: Number(row.used), heldTokens: Number(row.held), unresolved: Number(row.unresolved), activeRequests: Number(active.n), limit: this.limit(actor), personalLimit:this.personalLimit(actor) };
  }
  reserve(thread: string, model: string, turn?: string | null) {
    identifier(thread); identifier(model);
    return this.transaction(() => {
      const execution = this.execution(thread);
      if(execution) {
        this.currentExecution(execution.id);
        if(execution.model !== model) throw new ModelGatewayError("gateway_execution_model_forbidden",403);
        if(turn !== undefined) {
          if(!turn)throw new ModelGatewayError("gateway_execution_turn_required",403);
          identifier(turn);
          const bound=this.db.prepare("SELECT execution FROM gateway_execution_turns WHERE thread=? AND turn=?").get(thread,turn);
          if(bound && bound.execution!==execution.id)throw new ModelGatewayError("gateway_execution_changed",403);
          if(!bound) {
            if(this.db.prepare("SELECT 1 FROM gateway_execution_turns WHERE execution=? LIMIT 1").get(execution.id))throw new ModelGatewayError("gateway_execution_changed",403);
            // Native inference can reach the proxy before the turn-start ACK reaches the gateway.
            this.startedExecution(thread,turn,execution.id);
          }
        }
      }
      const actor = execution?.authorizer ?? this.sponsor(thread);
      if (!actor) throw new ModelGatewayError("gateway_human_sponsor_required", 403);
      const summary = this.summary(actor), limit = summary.limit;
      if (!limit) throw new ModelGatewayError("gateway_limit_not_configured", 403);
      if (summary.activeRequests >= limit.concurrency) throw new ModelGatewayError("gateway_concurrency_exhausted");
      if (summary.usedTokens + summary.heldTokens + limit.requestTokens > Math.min(limit.monthlyTokens,summary.personalLimit.monthlyTokens??Infinity)) throw new ModelGatewayError("gateway_budget_exhausted");
      const provider=model.startsWith("configured/")?decodeURIComponent(model.slice("configured/".length).split("/")[0]!):null;
      const owner=provider?this.contribution(provider)?.actor??null:null;
      if(owner && owner!==actor) {
        const spending=this.summary(owner),ceiling=Math.min(spending.limit?.monthlyTokens??Infinity,spending.personalLimit.monthlyTokens??Infinity);
        if(spending.usedTokens+spending.heldTokens+limit.requestTokens>ceiling)throw new ModelGatewayError("gateway_budget_exhausted");
      }
      const id = randomUUID(), at = this.now();
      this.db.prepare("INSERT INTO gateway_requests(id,actor,thread,model,credential,period,reserved,actual,state,created_at,updated_at,execution,key_owner,turn) VALUES(?,?,?,?,?,?,?,NULL,'reserved',?,?,?,?,?)")
        .run(id, actor, thread, model, null, summary.period, limit.requestTokens, at, at,execution?.id??null,owner,turn??null);
      return { id, actor, reservedTokens: limit.requestTokens };
    });
  }
  dispatched(id: string, credential: string | null = null) {
    if (credential !== null) identifier(credential);
    this.transaction(() => {
      const request = this.db.prepare("SELECT actor,thread,execution FROM gateway_requests WHERE id=?").get(identifier(id));
      if (!request) throw new ModelGatewayError("gateway_request_not_found", 404);
      if(request.execution) this.currentExecution(String(request.execution));
      let provider = credential;
      if (provider?.startsWith("configured/")) {
        const parts = provider.slice("configured/".length).split("/");
        if (parts.length !== 2) throw new ModelGatewayError("invalid_gateway_identity", 400);
        provider = decodeURIComponent(parts[0]);
      }
      const key = provider ? this.contribution(provider) : null;
      const parent = request.execution ? this.db.prepare('SELECT parent FROM gateway_executions WHERE id=?').get(String(request.execution))?.parent : null;
      if (key) {
        if (key.state !== "shared" || key.scope === "personal" && (request.execution ? !this.canUseForExecution(String(request.thread), provider!, String(request.actor), typeof parent === 'string' ? parent : null) : key.actor !== request.actor))
          throw new ModelGatewayError("gateway_personal_key_forbidden", 403);
        if (key.scope === "personal" && !request.execution) {
          // Pin the whole ancestry before dispatch, serialized with human admission.
          let thread: string | null = String(request.thread);
          const seen = new Set<string>();
          while (thread) {
            if (seen.has(thread) || seen.size >= 64) throw new ModelGatewayError("gateway_sponsor_cycle", 403);
            seen.add(thread);
            const foreign = this.db.prepare("SELECT 1 FROM gateway_thread_humans WHERE thread=? AND actor<>? LIMIT 1").get(thread, key.actor);
            if (foreign) throw new ModelGatewayError("gateway_personal_key_forbidden", 403);
            this.db.prepare("INSERT OR IGNORE INTO gateway_private_threads VALUES(?,?)").run(thread, key.actor);
            const parent: unknown = this.db.prepare("SELECT parent FROM gateway_sponsors WHERE thread=?").get(thread)?.parent;
            thread = typeof parent === "string" ? parent : null;
          }
        }
      }
      const result = this.db.prepare("UPDATE gateway_requests SET state='dispatched',credential=?,updated_at=? WHERE id=? AND state IN ('reserved','dispatched')")
        .run(credential, this.now(), identifier(id));
      if (!result.changes) throw new ModelGatewayError("gateway_request_not_dispatchable", 409);
    });
  }
  finish(id: string, actual: number | null, usage?: ModelGatewayTokenUsage) {
    if (actual !== null) count(actual);
    if (usage) {
      count(usage.inputTokens); count(usage.outputTokens);
      if (actual === null || usage.inputTokens + usage.outputTokens !== actual) throw new ModelGatewayError('invalid_gateway_usage', 400);
      for (const n of [usage.cacheReadTokens, usage.cacheWriteTokens]) if (n !== null) count(n);
      for (const n of [usage.cacheReadTokens, usage.cacheWriteTokens])
        if (n !== null && n > usage.inputTokens) throw new ModelGatewayError('invalid_gateway_usage', 400);
    }
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM gateway_requests WHERE id=?").get(identifier(id));
      if (!row) throw new ModelGatewayError("gateway_request_not_found", 404);
      if (row.state === "settled" || row.state === "released") {
        if (actual !== null && Number(row.actual) !== actual) throw new ModelGatewayError("gateway_settlement_conflict", 409);
        return;
      }
      const state = actual !== null ? "settled" : row.state === "reserved" ? "released" : "unknown";
      this.db.prepare("UPDATE gateway_requests SET state=?,actual=?,updated_at=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=? WHERE id=?")
        .run(state, actual, this.now(), usage?.inputTokens??null, usage?.outputTokens??null, usage?.cacheReadTokens??null, usage?.cacheWriteTokens??null, id);
    });
  }
  reconcile(id: string, actual: number, administrator: string, reason: string) {
    count(actual); identifier(reason); identifier(administrator);
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM gateway_requests WHERE id=?").get(identifier(id));
      if (!row || !["unknown", "dispatched", "reserved"].includes(String(row.state))) throw new ModelGatewayError("gateway_reconciliation_conflict", 409);
      this.db.prepare("UPDATE gateway_requests SET state='settled',actual=?,updated_at=? WHERE id=?").run(actual, this.now(), id);
      this.audit(administrator, "reconcile", id, { actual, reason, before: row.state });
    });
  }
  requests(actor: string) {
    return this.db.prepare("SELECT id,thread,turn,execution,actor,key_owner,model,credential,period,reserved,actual,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,state,created_at,updated_at FROM gateway_requests WHERE actor=? ORDER BY created_at DESC,id DESC LIMIT 100").all(identifier(actor));
  }
  contribution(provider: string) {
    const row = this.db.prepare("SELECT provider,actor,template_provider,state,scope,revision FROM gateway_contributions WHERE provider=?").get(identifier(provider));
    return row ? { provider: String(row.provider), actor: String(row.actor), templateProvider: String(row.template_provider), state: String(row.state), scope: String(row.scope) as ModelGatewayKeyScope, revision:Number(row.revision) } : null;
  }
  contributions(actor: string) {
    return this.db.prepare("SELECT provider,state,scope,revision,created_at FROM gateway_contributions WHERE actor=? ORDER BY created_at DESC LIMIT 100").all(identifier(actor));
  }
  canUse(provider: string, actor: string | null) {
    const key=this.contribution(provider);
    return !key || key.state === "shared" && (key.scope === "team" || key.actor === actor);
  }
  setScope(provider: string, actor: string, scope: ModelGatewayKeyScope, revision: number) {
    if(!["personal","team"].includes(scope))throw new ModelGatewayError("invalid_gateway_scope",400);
    count(revision);
    this.transaction(()=>{
      const key=this.contribution(provider);
      if(!key || key.actor!==actor || key.state!=="shared")throw new ModelGatewayError("gateway_contribution_forbidden",403);
      if(key.templateProvider==='codex-subscription'&&scope!=='personal')throw new ModelGatewayError('gateway_subscription_personal_only',403);
      if(key.revision!==revision)throw new ModelGatewayError("gateway_revision_conflict",409);
      this.db.prepare("UPDATE gateway_contributions SET scope=?,revision=revision+1 WHERE provider=?").run(scope,provider);
      this.audit(actor,"scope",provider,{scope,revision:revision+1});
    });
    return this.contribution(provider)!;
  }
  prepareContribution(provider: string, actor: string, templateProvider: string, scope: ModelGatewayKeyScope = "personal") {
    if (!["personal", "team"].includes(scope)) throw new ModelGatewayError("invalid_gateway_scope", 400);
    this.transaction(() => {
      this.db.prepare("INSERT INTO gateway_contributions(provider,actor,template_provider,state,created_at,scope) VALUES(?,?,?,'preparing',?,?)").run(identifier(provider), identifier(actor), identifier(templateProvider), this.now(), scope);
      this.audit(actor, "contribute", provider, { scope, shareWithTeam: scope === "team", templateProvider });
    });
  }
  reconnectContribution(provider:string,actor:string) {
    const key=this.contribution(provider);
    if(key?.actor!==actor||key.state!=='withdrawn'||key.templateProvider!=='codex-subscription')throw new ModelGatewayError('gateway_contribution_forbidden',403);
    this.db.prepare("UPDATE gateway_contributions SET state='preparing',scope='personal',revision=revision+1 WHERE provider=?").run(provider);
    this.audit(actor,'subscription-reconnect',provider,{});
  }
  contributionState(provider: string, actor: string, state: "shared" | "withdrawn") {
    this.transaction(() => {
      const row = this.contribution(provider);
      if (!row || row.actor !== actor || state === "shared" && row.state !== "preparing") throw new ModelGatewayError("gateway_contribution_forbidden", 403);
      this.db.prepare("UPDATE gateway_contributions SET state=? WHERE provider=?").run(state, provider);
      this.audit(actor, state, provider, {});
    });
  }
}

export function configuredModelGatewayPath(): string | undefined {
  const path = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  if (path !== undefined && !isAbsolute(path)) throw new ModelGatewayError("gateway_path_must_be_absolute", 503);
  return path;
}
