import { delegationTools } from "../../domain/assistant.mjs";
import { executePlatformRead, platformReadFailure } from "../platform-read.mjs";
import { memoryDocument, memorySearchTerms, memoryRecallTerms, memoryPromptView } from "../../domain/memory-recall.mjs";
import { Conversation } from "../../domain/conversation.mjs";
import {
  ReceptionQuery,
  RECEPTION_LIMITS,
  RECEPTION_QUERY_NAMES,
  MEMORY_QUERY_CONTRACTS,
} from "../../domain/reception-query.mjs";
import { CompletionContract } from "../../domain/completion-contract.mjs";

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : value);
const workSummary = (w, limit = 400) => ({
  id: w.id,
  goalId: w.goal_id ?? null,
  text: clip(w.text, limit),
  textTruncated: w.text.length > limit,
  revision: w.revision,
  status: w.status,
  error: clip(w.error, 120),
  updatedAt: w.updated_at,
  ...(w.execution_id
    ? {
        session: {
          executionId: w.execution_id,
          engine: w.harness,
          state: w.execution_status,
          bound: !!w.session_bound,
        },
      }
    : {}),
  ...(w.delivery_status
    ? {
        delivery: {
          status: w.delivery_status,
          acceptedAt: w.delivery_accepted_at,
          channel: "local-mailbox",
        },
      }
    : {}),
});
const questionSummary = (i) => ({
  ...(JSON.parse(i.metadata_json ?? "{}").choices
    ? {
        choices: JSON.parse(i.metadata_json).choices,
        allowCustom: JSON.parse(i.metadata_json).allowCustom,
      }
    : {}),
  kind: i.kind ?? "question",
  expiresAt: i.expires_at ?? null,
  id: i.id,
  workId: i.work_id,
  revision: i.revision,
  question: clip(i.question, 180),
  questionTruncated: i.question.length > 180,
});
const memorySummary = (m) =>
  m
    ? {
        key: m.key,
        document: memoryDocument(m),
        agentId: m.agentId,
        agentName: m.agentName,
        revision: m.revision,
        scope: m.scope ?? "user",
        kind: m.kind ?? "profile",
        projectId: m.projectId ?? null,
        updatedAt: m.updatedAt ?? null,
        evidenceIds: m.evidenceIds ?? [],
        deleted: !!m.deleted,
        value: clip(m.value, 1000),
        valueTruncated: typeof m.value === "string" && m.value.length > 1000,
      }
    : null;
function page(items, limit) {
  return {
    items: items.slice(0, limit),
    next: items.length > limit ? (items[limit - 1].id ?? items[limit - 1].path) : null,
  };
}

/** One coherent read capability. Depends only on SELECT-only views and a read-only material port. */
export class ReceptionQueries {
  constructor({
    authority,
    reads,
    platformReads = null,
    materials = null,
    attachments = null,
    timeZone = "UTC",
    now = Date.now,
  }) {
    Object.assign(this, {
      authority,
      reads,
      platformReads,
      materials,
      attachments,
      timeZone,
      now,
    });
  }
  grant(turn) {
    return this.authority.forTurn(turn);
  }
  availableResources(grant) {
    const current = this.materials?.reference();
    return [
      ...(this.authority.permits(grant, current) ? [current.id] : []),
      ...grant.resources
        .filter(
          (resource) =>
            ["platform.reads", "platform.threads", "execution.environment"].includes(resource.id) &&
            (resource.id !== "platform.reads" || this.platformReads) &&
            this.authority.permits(grant, resource),
        )
        .map((resource) => resource.id),
    ];
  }
  projectFor(grant) {
    return this.availableResources(grant).includes("materials") ? this.materials.reference().binding : null;
  }
  memoryView(grant) {
    return (
      this.authority.memoryView?.(grant) ?? {
        projectId: this.projectFor(grant),
        projectIds: this.projectFor(grant) ? [this.projectFor(grant)] : [],
      }
    );
  }
  seed(grant, { text = "" } = {}) {
    const workOverview = this.overview(grant);
    const questions = page(
      this.reads.questions(grant.conversationId, null, 7, grant.targetWork?.workId).map(questionSummary),
      6,
    );
    const view = this.memoryView(grant);
    const originalContext = this.reads.prompt(view);
    const initialView = {
      ...view,
      projectIds: originalContext.projects?.injected.map((p) => p.slug) ?? view.projectIds,
    };
    let recalled = this.reads.recall(initialView, { limit: 12, text }).map(memorySummary);
    const memoryContext = memoryPromptView(originalContext, recalled);
    const included = new Set([...memoryContext.profile, ...memoryContext.recent].map((m) => m.key));
    recalled = recalled.filter((m) => !included.has(m.key));
    return {
      seedObservedAt: this.now(),
      queryContracts: MEMORY_QUERY_CONTRACTS,
      platformReads: this.platformReads
        ? {
            operations: [
              "platform.groups.list",
              "platform.groups.history",
              "platform.groups.search",
              "platform.conversations.list",
              "platform.conversations.history",
            ],
            readOnly: true,
            visibility: "owner-current",
            externalContext: true,
          }
        : null,
      initialViewMayBeIncomplete: true,
      workOverview,
      goals: page(this.reads.goals(grant.conversationId, null, 7), 6),
      ...(grant.targetWork ? { targetWork: this.target(grant) } : {}),
      works: workOverview.attention,
      pendingInteractions: questions.items,
      questionsWorkId: grant.targetWork?.workId ?? null,
      questionsNext: questions.next,
      memories: this.reads.memories(12, this.memoryView(grant)).map((m) => {
        const { value: _value, ...metadata } = memorySummary(m);
        return { ...metadata, valueOmitted: true };
      }),
      memoryDefaultScope: this.authority.memoryDefaultScope ?? "user",
      memoryContext,
      memoryRecall: recalled,
      memoryRecallPolicy: {
        strategy: memoryRecallTerms(text).length ? "question-lexical-overlap" : "profile-and-recent",
        terms: memoryRecallTerms(text),
        textTruncated: text.length > 6000,
        semanticSearch: false,
      },
      routines: this.reads.routines(12).map((r) => ({ ...r, text: r.text.slice(0, 300) })),
      clock: { now: this.now(), timeZone: this.timeZone },
      capabilities: {
        resources: this.availableResources(grant),
        delegationTools: delegationTools(
          grant.resources.filter(
            (resource) =>
              (resource.id !== "platform.reads" || this.platformReads) && this.authority.permits(grant, resource),
          ),
        ).filter((tool) => ["platform_read", "thread_command", "environment_run"].includes(tool)),
        canPublishLocalNote: true,
        queries: RECEPTION_QUERY_NAMES.filter((name) => this.platformReads || !name.startsWith("platform.")),
        limits: RECEPTION_LIMITS,
      },
    };
  }
  open(turn) {
    const grant = this.grant(turn);
    const source = turn.source_json ? JSON.parse(turn.source_json) : null;
    grant.historyAnchor = source ? source.historyAnchor : Conversation.messageId(grant.conversationId, turn.id, "user");
    return new ReceptionQuerySession(this, grant);
  }
  reportGoal(grant, source) {
    if (!source.goalId) return null;
    const work = this.reads.work(grant.conversationId, source.workId)?.work;
    if (!work || work.goal_id !== source.goalId) throw new Error("Report goal does not own this work");
    const detail = this.reads.goal(grant.conversationId, source.goalId, {
      limit: 4,
    });
    if (!detail) throw new Error("Report goal is unavailable");
    const value = { ...detail, observedAt: this.now(), evidence: [] };
    for (const w of detail.works) {
      if (!w.resultId) continue;
      const report = this.reads.report(grant.conversationId, w.id);
      if (!report || w.resultId !== `result:${report.execution_id}`) continue;
      value.evidence.push({
        workId: w.id,
        resultId: w.resultId,
        text: report.text.slice(0, 1200),
        truncated: report.text.length > 1200,
      });
    }
    if (ReceptionQuery.bytes(value) > RECEPTION_LIMITS.resultBytes) {
      value.evidence = [];
      value.evidenceTruncated = true;
    }
    return ReceptionQuery.bytes(value) <= RECEPTION_LIMITS.resultBytes
      ? value
      : { id: source.goalId, detailsOmitted: true };
  }
  overview(grant) {
    const byStatus = Object.fromEntries(
      [
        "queued",
        "running",
        "waiting_input",
        "blocked",
        "awaiting_review",
        "awaiting_delivery",
        "completed",
        "cancelled",
      ].map((s) => [s, 0]),
    );
    for (const r of this.reads.overview(grant.conversationId)) byStatus[r.status] = r.count;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0),
      open = total - byStatus.completed - byStatus.cancelled;
    return {
      observedAt: this.now(),
      scope: "linked-conversation-work",
      total,
      open,
      byStatus,
      attention: this.reads.attentionWorks(grant.conversationId, 6).map((w) => workSummary(w)),
      attentionTruncated: open > 6,
      nextQuery: {
        kind: "query",
        name: "works.list",
        params: { state: "open", limit: 12 },
      },
      completionMeaning:
        "Work completion includes local-mailbox acceptance; it does not mean the user has read the result.",
    };
  }
  target(grant) {
    const row = this.reads.work(grant.conversationId, grant.targetWork.workId);
    if (!row) throw new Error("Target work is unavailable in this conversation");
    return {
      ...workSummary(row.work),
      capturedRevision: grant.targetWork.expectedRevision,
      changedSinceIntake: row.work.revision !== grant.targetWork.expectedRevision,
    };
  }
  materialSource(grant, source) {
    if (!this.availableResources(grant).includes(source))
      throw new Error("Material source is outside the captured query grant or its binding changed");
    return this.materials;
  }
  execute(grant, { name, params: p }) {
    const at = this.now();
    let data;
    switch (name) {
      case "goals.list":
        data = page(this.reads.goals(grant.conversationId, p.after, p.limit + 1), p.limit);
        break;
      case "goal.get":
        data = this.reads.goal(grant.conversationId, p.goalId, p);
        if (!data) throw new Error("Goal unavailable in this conversation");
        break;
      case "work.overview":
        data = this.overview(grant);
        break;
      case "report.read": {
        const report = this.reads.report(grant.conversationId, p.workId);
        if (!report) throw new Error("Report is unavailable in this conversation");
        data = {
          reportId: report.id,
          workId: report.work_id,
          revision: report.revision,
          status: report.status,
          text: report.text.slice(p.offset, p.offset + p.limit),
          nextOffset: p.offset + p.limit < report.text.length ? p.offset + p.limit : null,
        };
        break;
      }
      case "works.list":
        data = page(
          this.reads.works(grant.conversationId, p.after, p.limit + 1, p).map((w) => workSummary(w, 120)),
          p.limit,
        );
        break;
      case "work.get": {
        const row = this.reads.work(grant.conversationId, p.workId);
        if (!row) throw new Error("Work is unavailable in this conversation");
        const c = CompletionContract.forWork(row.work);
        data = {
          work: workSummary(row.work),
          completion: {
            objective: clip(c.objective, 400),
            requirements: c.requirements.slice(0, 4).map((x) => clip(x, 80)),
            checks: c.checks.map((x) => ({
              id: x.id,
              kind: x.kind,
              ...(x.path ? { path: clip(x.path, 120) } : {}),
              ...(x.text ? { text: clip(x.text, 80) } : {}),
              ...(x.sha256 ? { sha256: x.sha256 } : {}),
            })),
            semanticReview: row.assessment?.semanticReview ?? "unverified",
            passed: row.assessment?.passed ?? null,
            detailsMayBeTruncated: true,
          },
          delivery: row.delivery ? { ...row.delivery, error: clip(row.delivery.error, 120) } : null,
        };
        break;
      }
      case "questions.list":
        data = page(
          this.reads.questions(grant.conversationId, p.after, p.limit + 1, p.workId).map(questionSummary),
          p.limit,
        );
        break;
      case "attachments.list":
        data = this.attachments.list(p);
        break;
      case "history.read": {
        data = this.reads.historyMessage(grant.conversationId, p.messageId, grant.historyAnchor, p.offset, p.limit);
        if (!data) throw new Error("History message is outside this conversation or input anchor");
        break;
      }
      case "history.search": {
        const rows = this.reads.searchHistory(grant.conversationId, {
          ...p,
          anchorId: grant.historyAnchor,
          limit: p.limit + 1,
        });
        data = {
          items: rows.slice(0, p.limit).map((m) => ({
            ...m,
            text: m.text.slice(0, 1000),
            truncated: m.text.length > 1000,
          })),
          next: rows.length > p.limit ? String(rows[p.limit - 1].seq) : null,
          semanticSearch: false,
        };
        break;
      }
      case "memory.files.list": {
        const rows = this.reads.memoryFiles(this.memoryView(grant), {
          ...p,
          limit: p.limit + 1,
        });
        data = {
          items: rows.slice(0, p.limit),
          next: rows.length > p.limit ? rows[p.limit - 1].documentId : null,
          catalogue: "indexed-memory-files",
        };
        break;
      }
      case "memory.file.read":
        data = this.authority.readMemoryFile(grant, p);
        break;
      case "memory.search": {
        const rows = this.reads.recall(this.memoryView(grant), {
          ...p,
          limit: p.limit + 1,
        });
        data = {
          items: rows.slice(0, p.limit).map((m) => ({
            ...memorySummary(m),
            matches: memorySearchTerms(p.query, p.match)
              .map((term) => ({
                term,
                offset: m.value.toLowerCase().indexOf(term.toLowerCase()),
              }))
              .filter((h) => h.offset >= 0),
          })),
          match: p.match,
          next: rows.length > p.limit ? rows[p.limit - 1].key : null,
          semanticSearch: false,
          ...(!rows.length && p.match === "terms" && memorySearchTerms(p.query, p.match).length > 1
            ? {
                retryHint: {
                  reason:
                    "No exact match. Try fewer keywords, or list and read memory files; do not infer absence from this result.",
                  request: {
                    kind: "query",
                    name: "memory.search",
                    params: {
                      query: memorySearchTerms(p.query, p.match)
                        .slice(0, memorySearchTerms(p.query, p.match).length > 2 ? 2 : 1)
                        .join(" "),
                      match: "terms",
                    },
                  },
                },
              }
            : {}),
        };
        break;
      }
      case "memory.get": {
        const m = this.reads.memory(p.key, this.memoryView(grant));
        data = {
          key: p.key,
          exists: !!m,
          ...(m ? memorySummary(m) : { revision: 0 }),
        };
        break;
      }
      case "materials.list": {
        const source = this.materialSource(grant, p.source);
        const files = source
          .list(p.directory)
          .filter((f) => !p.after || f.path > p.after)
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        data = {
          source: p.source,
          ...page(files, p.limit),
          sourceListingMayBeCapped: true,
        };
        break;
      }
      case "material.read": {
        const source = this.materialSource(grant, p.source),
          material = source.read(p.path);
        const text = material.text.slice(p.offset, p.offset + p.limit);
        data = {
          source: material.source,
          path: material.path,
          sha256: material.sha256,
          totalCharacters: material.text.length,
          offset: p.offset,
          text,
          nextOffset: p.offset + text.length < material.text.length ? p.offset + text.length : null,
        };
        break;
      }
    }
    return { ok: true, observedAt: at, data };
  }
}

/** Per-plan ephemeral accounting. Read retries are safe; no query owns business state. */
class ReceptionQuerySession {
  #calls = 0;
  #bytes = 0;
  #trace = [];
  constructor(service, grant) {
    this.service = service;
    this.grant = grant;
  }
  get trace() {
    return structuredClone(this.#trace);
  }
  async executeAsync(request, signal) {
    if (!request?.name?.startsWith("platform.")) return this.execute(request);
    if (this.#calls >= RECEPTION_LIMITS.queries) throw Error("Reception query count exhausted");
    this.#calls++;
    let query, response;
    try {
      query = ReceptionQuery.parse(request);
      if (!this.service.platformReads)
        throw Object.assign(Error("Platform reading unavailable"), {
          code: "PLATFORM_READ_UNAVAILABLE",
        });
      signal?.throwIfAborted();
      response = await executePlatformRead(this.service.platformReads, query, signal, this.service.now);
    } catch (error) {
      signal?.throwIfAborted();
      response = {
        ok: false,
        observedAt: this.service.now(),
        error: String(error.message ?? error),
        failure: platformReadFailure(error),
      };
    }
    return this.record(query, response);
  }
  execute(request) {
    if (this.#calls >= RECEPTION_LIMITS.queries) throw new Error("Reception query count exhausted");
    this.#calls++;
    let query, response;
    try {
      query = ReceptionQuery.parse(request);
      response = this.service.execute(this.grant, query);
    } catch (error) {
      response = {
        ok: false,
        observedAt: this.service.now(),
        error: String(error.message ?? error),
      };
    }
    return this.record(query, response);
  }
  record(query, response) {
    let bytes = ReceptionQuery.bytes(response);
    if (bytes > RECEPTION_LIMITS.resultBytes) {
      response = {
        ok: false,
        observedAt: this.service.now(),
        error: "Reception query output exceeds its bound",
      };
      bytes = ReceptionQuery.bytes(response);
    }
    if (this.#bytes + bytes > RECEPTION_LIMITS.totalBytes) throw new Error("Reception query output budget exhausted");
    this.#bytes += bytes;
    this.#trace.push({
      name: query?.name ?? "invalid",
      params: query?.params ?? {},
      ok: response.ok,
      observedAt: response.observedAt,
      returnedBytes: bytes,
      ...(response.ok
        ? {
            source: response.data.source,
            path: response.data.path,
            sha256: response.data.sha256,
            ...(response.coverage ? { coverage: response.coverage } : {}),
          }
        : {
            error: response.error,
            ...(response.failure ? { failure: response.failure } : {}),
          }),
    });
    return {
      query: { name: query?.name ?? "invalid", params: query?.params ?? {} },
      response,
    };
  }
}
