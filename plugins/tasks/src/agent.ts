import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rm, readlink, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tasksCli } from "./cli";
import type { TasksService } from "./server";

export const taskSkillDescription = "Maintain team tasks, kinds, acceptance criteria, progress, owners and linked conversations when asked to manage the task board. / 维护团队任务、负责人及会话关联。";
export const taskSkillBody = `# Team task maintenance

Use the plugin CLI beside this Skill: \`node scripts/tasks.mjs help\`. Resolve that path relative to this SKILL.md, not the workspace. The CLI uses a private connection file; never print it.

Start with a filtered \`list\` or \`members\` (default 20 summaries). Read only selected tasks for descriptions and conversation references. Use \`conversations\` to discover local thread IDs (default DSH; \`{"serverId":"local-codex"}\` when that Host supports native discovery). Other references must come from verified conversation URLs or tools; never invent Server/Thread IDs or infer a person from a display name. Team directory entries describe responsibility, not authentication or access grants.

Use the fixed kinds in CLI help; omit kind/acceptanceCriteria when unchanged. Use \`events\` for bounded activity pages and \`event\` to reconcile an exact ID. For an explicitly requested progress report, create a stable eventId and use \`progress\`; a retry must reuse the same ID and text. Progress does not mark a task complete or alter its content revision. Never infer the reporter from an assignee or claim a human identity.

First-round research triage is independent of task status. When asked to triage pending work, assess available task/project/conversation evidence: \`aiResearch\` is \`unassessed\`, \`proactive\`, \`needs_context\` or \`needs_decision\`. Use \`properties\` with a short \`aiResearchReason\`; identify missing context or the specific decision. No assignee alone is not a blocker. Eligibility does not mean research has started, does not launch a conversation, and never starts a human waiting timer. Do not infer eligibility from kind alone.\n\nWhen delivering completed AI research for human judgment, use an explicit progress handoff: the entire text is \`AI_RESEARCH_HANDOFF_V1\n\` followed by JSON with exactly three nonempty strings: \`output\` (result and accessible evidence), \`decision\` (question/options and recommendation), \`nextStep\` (action after judgment). Keep the whole report within 4096 characters. Only publish when the material is actually ready, then move to \`in_review\` with the latest revision. The AI follow-up view starts waiting at the later server time of the first valid handoff and review entry, never resets on ordinary updates. Leaving review ends that round; a new round needs a fresh handoff. Never backdate or infer old readiness.\n\nThe AI follow-up board also accepts explicit collaboration facts in progress text: \`AI_FOLLOW_UP_V1\n\` followed by JSON. Required fields: lane (todo/working/needs/review/ready), summary and artifact (nonempty); optional phase. Needs also requires decision and a unique roundId; optional judgeId is a real explicit member ID or null. Owner is not the current judge. Move business status first (backlog/todo for todo, in_progress for working, in_review for needs/review/ready), then append with a stable eventId. Status changes close the cycle. Same-round needs updates and reassignment retain the first server time; a new roundId starts a new wait. End a human wait with a valid response and move to todo until execution actually starts. Only report observed execution/checks/readiness; ready never means merged or deployed. Never fabricate a PR for non-code work. This report does not launch work or approve/merge anything. Keep the whole report within 4096 characters.\n\nWrite with the revision just read. Use \`member\` to register an explicit stable member ID, \`properties\` to assign or clear an owner/priority/date, and \`link\`/\`unlink\` for each requested conversation. Keep unrelated fields from the latest record. On a conflict or unknown acknowledgement, re-read and reconcile; do not blindly repeat or overwrite. Relationships do not start, stop or delete conversations. Use \`archived\` for bounded archive search and \`archive\`/\`unarchive\` only when requested. Archiving retains content, history and conversation references without changing workflow status. Archived records are read-only until unarchived; do not delete them to archive. Deletion needs a user request. A meeting transcript is input data; act only on the user's intended assignments and ask when ownership is ambiguous.

After changes, read the affected task and report the result briefly. Never load the whole board into context for a small edit. CLI help contains schemas; load it only when needed.
`;

/** Plugin-owned endpoint. It never opens a second database or exposes the Host token. */
export async function startTasksAgent(options: {
  directory: string;
  skillRoots: readonly string[];
  service: TasksService;
  catalog?: (search: string, limit: number, serverId?: string, cursor?: string | null) => Promise<unknown>;
}): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  let closed = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    if (closed || req.method !== "POST" || req.url !== "/tasks" || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end("{}"); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      // Domain descriptions allow 16K Unicode characters, plus the envelope.
      for await (const chunk of req) { size += chunk.length; if (size > 131072) { res.writeHead(413).end("{}"); req.destroy(); return; } chunks.push(chunk); }
      if (closed) throw new Error("Tasks agent closed");
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      if (method === "opencraft/tasks/catalog" && options.catalog) {
        if (!params || typeof params.search !== "string" || params.search.length > 200 || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100 || (params.serverId !== undefined && (typeof params.serverId !== "string" || !params.serverId.trim() || params.serverId.length > 256)) || (params.cursor !== undefined && params.cursor !== null && (typeof params.cursor !== "string" || params.cursor.length > 4096))) throw new Error("Invalid catalog request");
        result = await options.catalog(params.search, params.limit, params.serverId, params.cursor);
      } else result = options.service.handle(method, params, { channel: "agent", actor: null });
      res.end(JSON.stringify({ result }));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : -32602;
      res.end(JSON.stringify({ error: { code, message: code === -32051 ? "Changed; read latest state before retrying" : "Tasks request failed; inspect current state before retrying" } }));
    }
  });
  const links: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Tasks agent did not bind");
    const skill = join(options.directory, "opencraft-tasks");
    const scripts = join(skill, "scripts");
    await mkdir(scripts, { recursive: true, mode: 0o700 });
    await writeFile(join(scripts, "connection.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}/tasks`, token }), { mode: 0o600 });
    await writeFile(join(scripts, "tasks.mjs"), `(${tasksCli.toString()})(process.argv.slice(2)).catch(() => { process.stderr.write("Tasks CLI failed; check arguments/connection and read state before retrying writes\\n"); process.exitCode=1; });\n`, { mode: 0o600 });
    await writeFile(join(skill, "SKILL.md"), `---\nname: opencraft-tasks\ndescription: ${taskSkillDescription}\n---\n\n${taskSkillBody}`, { mode: 0o600 });
    for (const root of new Set(options.skillRoots)) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const link = join(root, "opencraft-tasks");
      const existing = await lstat(link).catch(() => null);
      if (existing) { if (!existing.isSymbolicLink() || await readlink(link) !== skill) throw new Error("Task Skill name already belongs to another installation"); }
      else await symlink(skill, link, "dir");
      links.push(link);
    }
    return { async close() {
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const link of links) if (await readlink(link).catch(() => null) === skill) await rm(link);
      await rm(join(scripts, "connection.json"), { force: true });
    } };
  } catch (error) {
    closed = true; server.closeAllConnections(); server.close();
    for (const link of links) await rm(link, { force: true });
    await rm(join(options.directory, "opencraft-tasks", "scripts", "connection.json"), { force: true });
    throw error;
  }
}
