import { memoryProjectSlug } from "./memory-spaces.mjs";
import { requireText } from "./values.mjs";

export const MEMORY_KINDS = Object.freeze(["profile", "log"]);

// Bounded lexical preparation, not semantic search. Never consume answer options.
const queryStopWords = new Set(
  "a an the i me my we our you your it its this that these those am is are was were be been being do does did have has had to of in on at for from with by as and or but if so can could would should will may might please tell know about how what which who when where why some any very just also 我 你 您 我们 我的 你的 请 请问 可以 能 不能 吗 呢 啊 了 的 地 得 和 与 或 在 到 对 把 被 是 有 没有 这个 那个 一下 一个 一些 什么 怎么 如何 为什么 是否 想 要".split(
    /\s+/u,
  ),
);
// Shared lexical normalization for indexed facts and questions; no I/O or model.
export function memoryLexicalTokens(text) {
  if (typeof text !== "string") throw new Error("Memory text must be a string");
  return [...new Intl.Segmenter("en", { granularity: "word" }).segment(text)]
    .filter((w) => w.isWordLike)
    .map((w) => w.segment.toLowerCase());
}
export function memoryRecallTerms(text = "") {
  if (typeof text !== "string") throw new Error("Recall text must be a string");
  return [
    ...new Set(
      memoryLexicalTokens(text.slice(0, 6000)).filter(
        (w) => w.length > 1 && !queryStopWords.has(w),
      ),
    ),
  ].slice(0, 24);
}

// The prompt has one occurrence of each fact. The full context/snapshot API stays unchanged.
export function memoryPromptView(context, recalled = []) {
  const seen = new Set();
  let overflow = false;
  const unique = (rows, limit) => {
    const result = [];
    for (const m of rows)
      if (!seen.has(m.key)) {
        seen.add(m.key);
        if (result.length < limit) result.push(m);
        else overflow = true;
      }
    return result;
  };
  const projects = context.projects ?? { injected: [] };
  const parts = [
    context.agent,
    ...(projects.injected ?? []),
    context.user,
  ].filter(Boolean);
  const profile = unique(
    parts.length
      ? parts.flatMap((p) => p.profile ?? [])
      : (context.profile ?? []),
    50,
  );
  for (const m of recalled) seen.add(m.key);
  const recent = unique(
    parts.length
      ? parts.flatMap((p) => p.recent ?? [])
      : (context.recent ?? []),
    30,
  );
  return {
    mode: context.mode,
    semanticSearch: false,
    truncated: !!context.truncated || overflow,
    projectId: context.projectId,
    precedence: context.precedence,
    profile,
    recent,
    projects: {
      ...projects,
      injected: (projects.injected ?? []).map(
        ({ profile, recent, ...metadata }) => metadata,
      ),
    },
  };
}
export function memoryKind(value = "profile") {
  if (!MEMORY_KINDS.includes(value))
    throw new Error("Memory kind must be profile or log");
  return value;
}
export function memoryKey(key, scope = "user", projectId = null) {
  requireText(key, "memory key", 160);
  if (!["agent", "user", "project"].includes(scope))
    throw new Error("Memory scope must be agent, user or project");
  if (scope === "agent") {
    if (key.startsWith("@project/") || key.startsWith("@shared/"))
      throw new Error("Memory key belongs to another shard");
    if (key.startsWith("@agent/")) return key;
    requireText(key, "agent memory key", 152);
    return `@agent/${key}`;
  }
  if (scope === "user") {
    if (
      key.startsWith("@project/") ||
      key.startsWith("@agent/") ||
      key.startsWith("@shared/")
    )
      throw new Error("Project memory key requires its original project scope");
    return key;
  }
  if (!projectId)
    throw new Error(
      "Project memory needs a current authorized material binding",
    );
  if (!/^[a-f0-9]{64}$/.test(projectId)) memoryProjectSlug(projectId);
  const prefix = `@project/${projectId}/`;
  if (key.startsWith(prefix)) return key;
  if (key.startsWith("@project/"))
    throw new Error("Memory belongs to another project");
  requireText(key, "project memory key", 80);
  return prefix + key;
}
export function recallOptions({
  query = "",
  limit = 12,
  after,
  match = "literal",
} = {}) {
  if (typeof query !== "string" || query.length > 200)
    throw new Error("Memory query must be at most 200 characters");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Memory recall limit must be 1..50");
  if (after !== undefined) requireText(after, "memory cursor", 160);
  memorySearchTerms(query, match);
  return { query: query.trim(), limit, after, match };
}

export function memorySearchTerms(query = "", match = "literal") {
  if (!["literal", "terms"].includes(match))
    throw new Error("Memory match must be literal or terms");
  if (typeof query !== "string" || query.length > 200)
    throw new Error("Memory query must be at most 200 characters");
  const q = query.trim();
  const terms =
    match === "terms"
      ? [...new Set(q.split(/\s+/u).filter(Boolean))]
      : q
        ? [q]
        : [];
  if (terms.length > 8)
    throw new Error("Memory terms query allows at most 8 terms");
  return terms;
}
export function memoryDocument(row) {
  const path = row.path?.match(
    /(?:^|\/)(profile\.md|log\/\d{4}-\d{2}\.md)$/,
  )?.[1];
  if (!path) return null;
  return {
    scope: row.scope ?? "user",
    project: row.projectId ?? null,
    agentId: row.agentId ?? null,
    path,
  };
}
