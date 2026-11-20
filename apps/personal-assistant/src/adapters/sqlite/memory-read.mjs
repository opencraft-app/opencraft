import { memoryBm25Match } from "./memory-bm25.mjs";
import {
  memoryView,
  selectProjectMemories,
} from "../../domain/memory-spaces.mjs";
import {
  memorySearchTerms,
  memoryDocument,
  memoryRecallTerms,
} from "../../domain/memory-recall.mjs";
export const memoryColumns = `m.*,coalesce(d.scope,'user') AS scope,d.project_id AS projectId,coalesce(d.kind,'profile') AS kind,coalesce(d.updated_at,0) AS updatedAt,s.agent_id AS agentId,s.agent_name AS agentName,s.content_id AS contentId,s.path`;
export const memoryJoin = `memory m LEFT JOIN memory_detail d ON d.key=m.key LEFT JOIN memory_shard s ON s.key=m.key`;
export const memoryVisible = `(coalesce(d.scope,'user') IN ('user','agent') OR d.project_id IN (SELECT value FROM json_each(?)))`;
export const memoryVisibility = (value) =>
  JSON.stringify(memoryView(value).projectIds);
export function readMemories(
  db,
  view,
  {
    limit = 50,
    query = "",
    after = null,
    deleted = false,
    kind = null,
    match = "literal",
    scope = null,
  } = {},
) {
  return db
    .prepare(
      `SELECT ${memoryColumns},p.origin,p.evidence_json AS evidenceJson FROM ${memoryJoin} LEFT JOIN memory_provenance p ON p.key=m.key WHERE ${memoryVisible}
   AND (? IS NULL OR coalesce(d.scope,'user')=?) AND (?=1 OR m.deleted=0) AND (? IS NULL OR m.key>?) AND (? IS NULL OR coalesce(d.kind,'profile')=?) AND NOT EXISTS (SELECT 1 FROM json_each(?) term WHERE coalesce(instr(lower(m.key||' '||m.value),lower(term.value)),0)=0) ORDER BY m.key LIMIT ?`,
    )
    .all(
      memoryVisibility(view),
      scope, scope,
      deleted ? 1 : 0,
      after,
      after,
      kind,
      kind,
      JSON.stringify(memorySearchTerms(query, match)),
      limit,
    )
    .map(({ evidenceJson, ...m }) => ({
      ...m,
      value: m.deleted ? null : m.value,
      evidenceIds: evidenceJson ? JSON.parse(evidenceJson) : [],
    }));
}
export function recallMemories(
  db,
  view,
  { query = "", limit = 12, after, match = "literal", text = "" } = {},
) {
  if (query || after)
    return readMemories(db, view, { query, limit, after, match });
  const terms = memoryRecallTerms(text);
  if (terms.length) {
    return db
      .prepare(
        `SELECT ${memoryColumns},p.origin,p.evidence_json AS evidenceJson,
      bm25(memory_bm25) AS relevance
      FROM ${memoryJoin} JOIN memory_bm25 ON m.key=memory_bm25.key
      LEFT JOIN memory_provenance p ON p.key=m.key
      WHERE memory_bm25 MATCH ? AND ${memoryVisible} AND m.deleted=0
      ORDER BY relevance ASC,coalesce(d.updated_at,0) DESC,m.key LIMIT ?`,
      )
      .all(memoryBm25Match(terms), memoryVisibility(view), limit)
      .map(({ evidenceJson, ...m }) => ({
        ...m,
        evidenceIds: evidenceJson ? JSON.parse(evidenceJson) : [],
      }));
  }
  const part = (kind, n) =>
    db
      .prepare(
        `SELECT ${memoryColumns} FROM ${memoryJoin} WHERE ${memoryVisible} AND m.deleted=0 AND coalesce(d.kind,'profile')=? ORDER BY CASE coalesce(d.scope,'user') WHEN 'agent' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,coalesce(d.updated_at,0) DESC,m.key LIMIT ?`,
      )
      .all(memoryVisibility(view), kind, n);
  const profiles = part("profile", Math.ceil((limit * 2) / 3));
  return [...profiles, ...part("log", limit - profiles.length)];
}
export function promptMemories(db, value) {
  const view = memoryView(value),
    rows = readMemories(db, view, { limit: 10000 }),
    state = { truncated: false };
  const part = (scope, projectId, kind, n, budget) => {
    const all = rows
      .filter(
        (r) =>
          r.scope === scope && r.projectId === projectId && r.kind === kind,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    let chars = 0;
    const result = [];
    if (all.length > n) state.truncated = true;
    for (const m of all.slice(0, n)) {
      const content = m.value.replace(/\s+/gu, " ").trim().slice(0, 500),
        size = content.length + (m.agentName?.length ?? 0) + 24;
      if (chars + size > budget && result.length) {
        state.truncated = true;
        break;
      }
      chars += size;
      result.push({
        key: m.key,
        content,
        scope: m.scope,
        projectId: m.projectId,
        kind: m.kind,
        createdAt: m.updatedAt,
        agentId: m.agentId,
        agentName: m.agentName,
      });
    }
    return result;
  };
  const block = (scope, projectId, pn, rn, pb, rb) => ({
    profile: part(scope, projectId, "profile", pn, pb),
    recent: part(scope, projectId, "log", rn, rb),
  });
  const agent = block("agent", null, 100, 30, Infinity, 4000),
    user = block("user", null, 50, 15, 4000, 2000);
  const blocks = view.projectIds.map((slug) => ({
    slug,
    name: view.projectNames?.[slug] ?? slug,
    ...block("project", slug, 25, 10, 2500, 1500),
  }));
  const projects = selectProjectMemories(blocks, 3);
  return {
    profile: [
      ...agent.profile,
      ...projects.injected.flatMap((b) => b.profile),
      ...user.profile,
    ].slice(0, 50),
    recent: [
      ...agent.recent,
      ...projects.injected.flatMap((b) => b.recent),
      ...user.recent,
    ].slice(0, 30),
    agent,
    user,
    projects,
    truncated: state.truncated,
    projectId: view.projectId,
    mode: "profile-and-recent",
    semanticSearch: false,
    precedence: ["agent", "project", "user"],
  };
}

export function listMemoryFiles(db, view, { after = null, limit = 13 } = {}) {
  return db
    .prepare(
      `SELECT DISTINCT s.path,d.scope,d.project_id AS projectId,s.agent_id AS agentId FROM ${memoryJoin} WHERE ${memoryVisible} AND m.deleted=0 AND s.path IS NOT NULL AND (? IS NULL OR s.path>?) AND (d.scope!='agent' OR s.agent_id=?) ORDER BY s.path LIMIT ?`,
    )
    .all(
      memoryVisibility(view),
      after,
      after,
      memoryView(view).agentId ?? "",
      limit,
    )
    .map((row) => ({ documentId: row.path, ...memoryDocument(row) }));
}
