/** Self-contained so the plugin can materialize the same CLI in packaged Hosts. */
export async function tasksCli(args: string[]): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const command = args.shift() ?? "help";
  const help = `opencraft-tasks <command> [JSON]
Commands:
  list {search?,status?,kind?,aiResearch?,assigneeId?,limit?:20,offset?:0}
  read {id} | members {search?,limit?:20,offset?:0}
  conversations {serverId?,search?,cursor?,limit?:20}
  create {id,title,description?,kind?,acceptanceCriteria?,status?,projectServerId?,projectId?}
  update {id,expectedRevision,title,description,projectServerId,projectId,kind?,acceptanceCriteria?}
  properties {id,expectedRevision,assigneeId?,priority?,dueDate?,aiResearch?,aiResearchReason?} (at least one)
  member {id,name,expectedRevision:null|number,identity?:{kind,id}|null}
  move {id,expectedRevision,status,beforeId:null|id}
  link / unlink {id,expectedRevision,serverId,threadId}
  archive / unarchive {id,expectedRevision}
  archived {search?,limit?:20,before?:{archivedAt,id}} (retained records, keyset pages)
  remove / restore {id,expectedRevision}
  events {taskId,beforeSeq?,limit?:20} | event {taskId,eventId}
  progress {taskId,eventId,text} (stable eventId; 1..4096 chars)
  for-conversation {serverId,threadId,limit?:20,offset?:0}
Kinds: unclassified,feature,improvement,bug,engineering,harness,research,documentation,operations,growth,task.
AI research: unassessed,proactive,needs_context,needs_decision. A non-unassessed assessment requires aiResearchReason.
Statuses: backlog,todo,in_progress,in_review,done,canceled.
Priorities: none,low,normal,high,urgent. dueDate: YYYY-MM-DD or null.
Stable member IDs are explicit handles/email/employee IDs, never inferred from names.
Profile identity is optional display data (employee id = explicit login handle). Omit to retain, null to clear; never grants authentication or permissions.
Read revision before writes. On conflict/timeout, read again; never blindly replay.
Pass JSON as one shell-quoted argument, or '-' to read stdin.`;
  if (command === "help" || command === "--help") { process.stdout.write(help + "\n"); return; }
  let input = args.shift() ?? "{}";
  if (input === "-") { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); input = Buffer.concat(chunks).toString("utf8"); }
  const p = JSON.parse(input);
  if (!p || typeof p !== "object" || Array.isArray(p) || args.length) throw new Error("Expected one JSON object");
  const configPath = process.env.OPENCRAFT_TASKS_CONFIG ?? join(dirname(process.argv[1]!), "connection.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const url = new URL(config.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("Invalid local Tasks endpoint");
  const methods: Record<string, string> = { archive: "archive", unarchive: "unarchive", archived: "archive/list", list: "list", events: "events/list", event: "events/read", progress: "progress/append", restore: "restore", read: "read", members: "list", create: "create", update: "update", properties: "properties/update", member: "members/upsert", move: "move", link: "conversations/attach", unlink: "conversations/detach", remove: "remove", "for-conversation": "conversations/tasks", conversations: "catalog" };
  const suffix = methods[command];
  if (!suffix) throw new Error("Unknown command; run help");
  const limit = p.limit ?? 20, offset = p.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid page; limit must be 1..100");
  const queryFields: Record<string, readonly string[]> = {
    list: ["search", "status", "kind", "aiResearch", "assigneeId", "limit", "offset"],
    members: ["search", "limit", "offset"],
    conversations: ["serverId", "search", "cursor", "limit"],
    "for-conversation": ["serverId", "threadId", "limit", "offset"],
  };
  const fields = queryFields[command];
  if (fields && Object.keys(p).some(key => !fields.includes(key))) throw new Error("Unknown query field; run help");
  if (fields && p.search !== undefined && (typeof p.search !== "string" || p.search.length > 200)) throw new Error("Search must be at most 200 characters");
  if (command === "list") {
    if (p.aiResearch !== undefined && !["unassessed", "proactive", "needs_context", "needs_decision"].includes(p.aiResearch)) throw new Error("Invalid AI research disposition");
    if (p.status !== undefined && !["backlog", "todo", "in_progress", "in_review", "done", "canceled"].includes(p.status)) throw new Error("Invalid status; run help");
    if (p.assigneeId !== undefined && p.assigneeId !== null && (typeof p.assigneeId !== "string" || !p.assigneeId.trim() || p.assigneeId.length > 256)) throw new Error("Invalid member ID");
  }
  const params = command === "archived" ? { limit, ...p } : command === "list" || command === "members" ? {} : command === "conversations" ? { search: p.search ?? "", limit, ...(p.serverId === undefined ? {} : { serverId: p.serverId }), ...(p.cursor === undefined ? {} : { cursor: p.cursor }) } : command === "for-conversation" ? { serverId: p.serverId, threadId: p.threadId } : command === "create" ? { description: "", status: "backlog", projectServerId: null, projectId: null, ...p } : p;
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify({ method: `opencraft/tasks/${suffix}`, params }), signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error(`Tasks request failed (${response.status}); read state before retrying writes`);
  const reply = await response.json() as { error?: unknown; result: any };
  if (reply.error) { process.stdout.write(JSON.stringify({ error: reply.error }) + "\n"); process.exitCode = 1; return; }
  let result = reply.result;
  if (command === "members") {
    const rows = (result.members ?? []).filter((m: { name: string; id: string }) => !p.search || `${m.name} ${m.id}`.toLocaleLowerCase().includes(String(p.search).toLocaleLowerCase()));
    result = { members: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
  } else if (command === "member") {
    result = { member: result.members.find((m: { id: string }) => m.id === p.id) };
  } else if (command === "archived") {
    result = { tasks: result.tasks.map((task: { id: string; title: string; status: string; kind?: string; revision: number; archivedAt: number; assigneeId?: string | null; priority?: string; dueDate?: string | null; conversations: unknown[] }) => ({ id: task.id, title: task.title, status: task.status, kind: task.kind ?? "unclassified", revision: task.revision, archivedAt: task.archivedAt, assigneeId: task.assigneeId ?? null, priority: task.priority ?? "none", dueDate: task.dueDate ?? null, conversationCount: task.conversations.length })), nextCursor: result.nextCursor };
  } else if (command === "archive") {
    result = { id: p.id, archived: true };
  } else if (result.tasks && command !== "archived") {
    const rows = result.tasks.filter((t: { title: string; description: string; status: string; kind?: string; aiResearch?: string; assigneeId?: string | null; conversations: {serverId:string;threadId:string}[] }) => command !== "list" || ((!p.search || `${t.title} ${t.description}`.toLocaleLowerCase().includes(p.search.toLocaleLowerCase())) && (!p.status || t.status === p.status) && (!p.kind || (t.kind ?? "unclassified") === p.kind) && (!p.aiResearch || (t.aiResearch ?? "unassessed") === p.aiResearch) && (p.assigneeId === undefined || (t.assigneeId ?? null) === p.assigneeId)));
    const selected = command === "list" || command === "for-conversation" ? rows.slice(offset, offset + limit) : rows.filter((t: {id:string}) => t.id === p.id);
    result = { tasks: selected.map((t: {id:string;title:string;status:string;kind?:string;aiResearch?:string;latestProgress?:unknown;revision:number;assigneeId?:string|null;priority?:string;dueDate?:string|null;conversations:unknown[]}) => ({ id:t.id,title:t.title,status:t.status,kind:t.kind ?? "unclassified",aiResearch:t.aiResearch ?? "unassessed",latestProgress:t.latestProgress ?? null,revision:t.revision,assigneeId:t.assigneeId ?? null,priority:t.priority ?? "none",dueDate:t.dueDate ?? null,conversationCount:t.conversations.length })), ...(command === "list" || command === "for-conversation" ? { total:rows.length,nextOffset:offset+limit < rows.length ? offset+limit : null } : {}) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
